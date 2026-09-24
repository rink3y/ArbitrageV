# ArbitrageV

A Bun/TypeScript arbitrage bot that keeps an EVM market graph in memory, searches circular trades, and executes them through a V2 or V3 flash loan. The adapters cover Uniswap-style V2, Solidly stable/volatile pools, Uniswap V3 and Carbon. Direct routes and split-and-merge routes share the same graph and execution pipeline.

This is a working bot that finds arbitrage opportunities and can execute trades on-chain, developed as a learning project. A profitable local quote is not proof that a transaction will succeed. Token behavior, incomplete event feeds, inclusion delay and competition can all invalidate it. The current configuration targets Cronos with V2 only.

## Before running it

Use Bun. The runtime depends on its worker and SQLite APIs. Copy `.env.example` to `.env` if you do not already have one, then install dependencies with `bun install`.

**The checked-in settings enable trading.** Set `EXECUTION_POLICY.executeTrades = false` in `src/constants.ts` before testing a deployment. `splitRouting: 'live'` still searches split routes with this switch off; neither direct nor split trades can be submitted.

Configure these environment variables:

- `RPC_URL` and `UNISWAP_FLASH_QUERY_CONTRACT_ADDRESS` are needed for market sync. `WSS_URL` is optional; events fall back to HTTP when WebSocket initialization fails.
- `PRIVATE_KEY` is required by `bun start` even with execution disabled, because startup creates the wallet client. Sync does not need a signing key.
- `ARB_CONTRACT_ADDRESS` is required for execution and for V2 transfer profiling, including profiling during read-only sync.
- `MARKET_DB_PATH` overrides `data/markets-<chainId>.sqlite`. `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` enable alerts; leave both blank to disable them.

Deploy contracts matching the source. `Contract/NArb.sol` defines `ArbitrageExecutor(owner, wrappedNativeToken)`; the signing wallet must be its owner. `Contract/UniswapFlashQuery.sol` defines `FlashUniswapQueryV1`. Tax profiling needs compatible deployments of both. Both execution tuples now omit the old quoted-profit minimum. Deploy the updated executor and change `ARB_CONTRACT_ADDRESS` before using this bot; the old executor cannot accept the new calldata. This profit-check change does not require a new FlashQuery deployment if it already supports transfer profiling.

`forge build` compiles the contracts. `bun run abi:arb` then regenerates both JSON ABIs in `src/ABI/` from those artifacts. Deployment is separate; sync and startup never deploy contracts or update deployed bytecode.

Once addresses and settings are checked:

```sh
bun run sync:markets
bun start
```

Sync saves market metadata and, with V2 profiling enabled, transfer observations. Startup subscribes in buffering mode, loads current state, warms the search worker, reconciles buffered events, then starts searching. The first profile pass or full V3 snapshot can take several minutes. Stop with `Ctrl+C`.

## Configuration that changes what gets traded

`src/constants.ts` owns network, token, search, execution and logging settings. `ARBITRAGE_SEARCH_POLICY.allowedProtocols` controls discovery, startup reads, subscriptions and search. You can enable one protocol, any two, or all three, subject to the transfer-profiling restriction below. For example, use `['v2']`, `['v2', 'v3']`, or `['v2', 'v3', 'carbon']`. Keep at least one protocol. You do not need to edit the registry to turn an existing adapter off.

`V2_LIVE_POLICY.transferFees` is currently `true`. Transfer profiling requires V2-only routing. To use V3 or Carbon, disable that mode in `src/protocols/v2/config.ts` and restrict trading to tokens compatible with the untaxed quote assumptions. Transfer-tax profiling is not yet supported for V3 or Carbon; a V2 profile does not establish that the same token is compatible with either.

`TOKENS` supplies start-token addresses, decimals, `liquidityAmount` and `minProfit`. Both searches start from the first `topTokens` entries, currently six. Intermediate tokens come from the graph; they do not all need to be in `TOKENS`. Use `tokenAmount(value, decimals)` for thresholds. `liquidityAmount` is a loading filter, not the amount the bot borrows.

Factory and controller settings stay with their adapters:

- `src/protocols/v2/config.ts`: `V2_FACTORIES`, with a factory address, `kind` and fee. V2 fees use basis points, so `30` means 0.30%. Solidly discovery reads stable/volatile fees from the factory.
- `src/protocols/v3/config.ts`: `V3_FACTORIES`, with an inclusive `fromBlock` and `enabled` flag. Set the start block at or before deployment to discover every pool. V3 fees use parts per million, so `3000` means 0.30%.
- `src/protocols/carbon/config.ts`: `CARBON_CONTROLLERS`, with an address and `enabled` flag. Pair fees come from the controller.

Restart after configuration changes. Refresh the affected protocol before starting if its discovery configuration changed:

```sh
bun run sync:markets --protocol v3
bun run sync:markets --protocol v2 --protocol carbon
```

With no arguments, sync uses `allowedProtocols`. `--all` selects all three. Explicit selection preserves stored markets for unselected protocols; it does not enable them at runtime. Carbon-only sync uses the stored V2/V3 markets as part of its token universe.

Changing networks requires more than changing the RPC URL. Set `NETWORK.chain` to the full viem chain definition and `NETWORK.wrappedNativeToken` to its wrapper, then review `TOKENS`, all enabled factories/controllers, bans and deployed contracts. Adapter addresses are separate configuration and are not rewritten when the chain changes. The executor's immutable wrapper must match and support standard 1:1 `deposit()`/`withdraw(uint256)` behavior.

HTTP chain-ID mismatch stops startup or sync; a mismatched WebSocket endpoint falls back to HTTP. Each SQLite file is bound to one chain. A file from another chain, or an old catalog without a chain identity, is rejected rather than relabeled. Use a fresh path and sync. The adapters require compatible contract behavior, not merely a DEX with the same protocol name. Algebra, dynamic V3 fees, non-EVM chains and cross-chain trades are outside this implementation.

## Discovery is not live liquidity

The database keeps a filtered trading list separately from the complete V2/V3 discovery catalogs and checkpoints. Disabling a protocol or replacing the trading list does not erase its discovery history.

V2 discovery reads factory pair counts and fetches indexes after the saved checkpoint. A changed factory configuration, count rollback or checkpoint reorg causes that factory to be rebuilt. V3 discovery scans `PoolCreated` logs across all fee tiers, then batches immutable metadata reads through FlashQuery. Phase one saves tokens, fee, tick spacing, creation block and legal bitmap bounds. Neither a pool address nor those bounds tells us its current liquidity.

At V3 startup, phase two reads price, current tick, active liquidity, every bitmap word in the legal range and every initialized tick, pinned to one block per snapshot. This is enough to quote swaps across multiple initialized ticks. It is not a download of individual LP positions, and there is no 512-tick total cap. `V3_STARTUP_POLICY` controls pagination and concurrency.

Interrupted V3 downloads retain a cursor but never enter the trading graph as partial snapshots. Completed snapshots include a block hash; restart verifies that hash and catches up missed events. Reorgs or unavailable historical reads/logs trigger a fresh snapshot. Live Swap, Mint and Burn events update state and tick boundaries locally. Invalid ordering, removed logs or inconsistent liquidity make a pool unavailable until recovery succeeds.

V3 also rotates block-pinned checkpoints: currently ten pools per batch, normally sixty seconds between batches, five seconds during recovery. That is not one refresh per pool per minute. Events received during a checkpoint are replayed afterward; replay-buffer overflow leaves the pool unavailable. The query adapter handles standard Uniswap V3 events and Sailor's extended Swap event.

Carbon reads current controller pairs and strategies rather than scanning historical factory logs. Create, update and delete events change the in-memory strategies. The worker gets a full snapshot at startup/recovery and strategy deltas afterward. Updates rebuild the affected pair's directions, not every Carbon edge. Grouped routes consider at most eight orders; controller and strategy ID identify the liquidity being spent.

V2/V3 factory feeds keep discovering new pools after startup. Factory creation events trigger a check immediately; the shared `RUNTIME.marketDiscoveryIntervalMs` runs a four-hour catch-up check in case an event was missed. A selected new pool is subscribed before hydration. Unchanged V2 checks do not reload/filter the catalog or repeat the full `Found ... V2 pools` summary. A startup reconciliation repairs interrupted catalog updates.

Expect discovery, database and live-pool counts to differ. `src/bannedtax.json` excludes tokens explicitly. The shared filter requires both tokens to occur in more than one market. V2 then applies reserve/activity filters, Carbon applies its liquidity filter, and V3 needs a usable snapshot. V2's fallback threshold for tokens outside `TOKENS` is a raw-unit threshold in `V2_DISCOVERY_POLICY`, not a dollar valuation.

The RPC must return complete logs and support block-pinned reads. Range-limit errors can be retried in smaller batches; silent truncation cannot. Subscription recovery and checkpoints help repair missed events, but cannot fix a provider that omits them from both subscriptions and history.

## How transfer taxes enter a quote

Tax is a property of an observed transfer context, not one permanent percentage attached to a token. The same token can behave differently on two pools. We keep separate buy, sell and external-transfer observations for each pool/token/executor/origin combination in `v2_transfer_profiles`.

FlashQuery batches unsigned `eth_call` simulations through NArb. NArb borrows a sample from the pool, measures both balances, sends half its received amount to its owner, and transfers the remainder back to the pool. It deliberately reverts with the measurements so each probe restores state before the next one. These calls use RPC resources but send no transaction and spend no wallet gas.

The measured paths are pool → NArb for buy, NArb → that pool for sell, and NArb → its owner for external transfer. The token sees NArb as the transferring contract; the simulated origin is its owner. The external-transfer result is informational. It does not describe arbitrary recipients, and a successful sell-transfer probe does not prove that a complete sell swap will succeed.

With profiling enabled, V2 proceeds return to NArb between hops, for both direct and split routes. The quote deducts the input token's sell tax, applies pool math including its swap fee, then deducts the output token's buy tax. For example:

```text
100 input
  -> 10% sell deduction: pool receives 90
  -> AMM quotes 200 output for that 90, after its swap fee
  -> 22% buy deduction: NArb receives 156
```

Those are illustrative amounts, not a quoted trade. The next hop starts with 156 and applies its own pool-specific deductions. We do not add buy and sell percentages to approximate an unmeasured pool-to-pool transfer. Returning through NArb costs more contract gas, but matches the transfer paths we probed. With profiling disabled, consecutive direct V2 hops can forward pool-to-pool and quotes assume no tax.

The executor uses `balanceOf(pool) - reserveIn` as effective V2 input and the recipient's balance increase as output. It rejects extra sender debits. Do not rely on a token's `Transfer` event amount or a successful `transfer()` return value as evidence that the recipient received the requested amount.

The configured probes sample reserve fractions from 1/100,000,000 through 1/4. A usable estimate needs at least two distinct amounts, exact sender debits, positive recipient credits and deduction rates agreeing within one basis point. Quotes use the largest rounded-up observed deduction and reject amounts outside the measured range. Unknown, failed and unsupported profiles are not treated as zero tax. The flash-borrowed asset needs observed zero buy/sell deductions on its funding pool, with borrowing and repayment inside the measured bounds. Explicit bans still win.

Sync and startup fill missing or expired observations. The current `transferRefreshMs` is four hours. After startup, the V2 adapter schedules the next probe for the earliest profile expiry, or wakes when a newly hydrated pair has no profile. A long initial pass gives many profiles the same observation time, so a later refresh can look like another large startup pass. Current cached profiles are reused after block-hash validation. Expired ones stop being eligible until refreshed; failed refreshes retry after a minute and do not reopen them.

Refreshes publish new pool revisions and merge profiles into the latest reserves without overwriting intervening events. The worker receives estimates without raw samples, and unchanged profiles are omitted from later reserve patches. Search, signing and submission never perform probe RPCs.

These samples do not establish token safety. Untested amount thresholds, changing exemptions, rebases, trailing fees or caller-dependent behavior can still break a route. Validate an unfamiliar token and actual route on a fork before paying to execute it. Profiling is not a full-route simulation.

## Direct and split search

The direct search visits circular paths, ranks a bounded candidate shortlist by marginal exchange rate, then sizes amounts using integer quotes. Current limits are five route edges, 50,000 exploration attempts and 64 candidates to size. Lower limits reduce work but can miss trades. `maxInputReserveFraction: 10n` caps opening input at one tenth of the relevant capacity; it does not require borrowing that much.

`splitRouting: 'off'` skips split work. `'live'` adds it after the direct search, using the same tokens, filters and graph. The execution switch remains independent. Direct candidates are retained; enabling splits does not replace them.

A split stage converts one token into one other token through one or two branches, then merges the proceeds. Plans have two or three stages, at most six swaps, and at least one two-branch stage. A simple two-stage example, using zero-fee/no-tax toy amounts:

```text
                   100 A -> pool 1 -> 181 B
borrow 200 A -----<                        >----- 362 B -> pool 3 -> 306 A
                   100 A -> pool 2 -> 181 B

repay 200 A; 106 A remains before flash fees and gas
```

That is three swaps, not two. A three-stage cycle could be `A -> B -> C -> A`, with two pools on every stage for six swaps total. Branches within a stage must share the input/output token; splitting into different intermediate-token paths is not supported. Pools and Carbon strategy liquidity cannot be reused within a plan, and the funding pool must sit outside it.

Split search takes short token cycles from direct discovery before the direct profit filter. It tries pool subsets and amount allocations, returning at most one winning split per borrow token alongside the direct results. The split must beat the best sized, funded direct candidate for that token. It is a bounded heuristic, not an exhaustive or globally optimal router.

`splitSearchMs` currently gives split search ten extra milliseconds. Direct and split exploration use separate work budgets. Checks are cooperative, so a tick walk, GC or worker scheduling can overshoot the time limit. Both searches run in the same worker job; split work delays that job's return. `split.budgetStops` means exploration stopped early, not that no profitable split exists. `split.work` counts search work, not transactions, and zero winners can simply mean the direct route was better.

Split amounts and minimum outputs are fixed in the signed plan. Later stages are funded from preceding minimum proceeds. `slippageBps` reduces each branch's quoted output; favorable leftovers are not counted toward the quote's profit. The contract checks actual spending and receipt deltas and cannot use old balances to cover an underfunded branch.

## Execution, costs and stale results

A route needs an enabled V2/V3 funding pool outside its swap pools. Carbon cannot lend, so Carbon-only routing does not produce executable trades. `allowProtocolMixing: false` restricts the swap route, not the funding protocol.

Gas prices are estimated through the existing HTTP client at startup and every `feeRefreshIntervalMs`, currently five minutes. `legacy: true` uses `gasPrice`; `false` uses EIP-1559 maximum and priority fees. There is no manual fee mode. If a refresh fails, returns an invalid estimate or exceeds `feeCeilingPerGas`, the bot keeps the previous valid quote until its original expiry. Searches and submissions pause when there is no valid quote, including at startup or after that expiry. A quote expires after twice the refresh interval; a failed refresh never extends it. If fees really have risen, a transaction signed with the older cap may remain pending.

The search charges the full configured `gasLimit` at the estimated fee cap. At the current 1,500,000 gas limit, a hypothetical 400 gwei cap produces a 0.6-native-token allowance. The 1,000 gwei ceiling is a rejection threshold, not the price always used. There is no per-route gas estimation or calibrated per-protocol gas model, so this allowance neither proves a route fits the limit nor accurately compares actual gas for different routes. Rollup L1 data fees are not modeled.

Gas must be expressed in the borrow token before comparing profits. The configured wrapped native token uses a 1:1 raw-unit conversion. Other `TOKENS` entries need a fresh `gasConversion: { numerator, denominator, validUntil }`, in smallest token units per native wei with a Unix-millisecond expiry. No price oracle refreshes these rates automatically. Missing or expired conversion data excludes that start token even with trading disabled.

Reported `profit` is quoted surplus after flash repayment, before gas; `netProfit` subtracts the conservative gas allowance. Direct routes must exceed token `minProfit` after gas. Splits currently use a different floor: surplus before gas must exceed `minProfit`, net must be positive, and net must beat the direct baseline. Ranking across different borrow tokens is scaled by their configured `minProfit`, not a common USD price.

Both contract entry points are owner-only, validate callbacks and protect pre-existing borrowed-token inventory. After the lender finishes, the executor measures the increase in its borrowed-token balance. Other tokens need a strictly positive surplus after loan fees. The configured wrapped native token must also cover the contract's gas-cost calculation. `NoProfit()` means no token surplus remains; `InsufficientProfitAfterGas(profit, gasCost)` reports a wrapped-native surplus that does not cover gas. `InsufficientFlashLoanRepayment()` is reserved for an inability to repay without spending old inventory.

The gas check measures execution through repayment and the lender's final checks, uses `tx.gasprice` for both legacy and EIP-1559 transactions, and adds 21,000 intrinsic gas, 16 gas per calldata byte and a 10,000-gas allowance for entry and cleanup. It also applies an all-nonzero-byte upper bound for the EIP-7623 calldata floor. Charging every byte as nonzero and ignoring gas refunds makes this conservative, not an exact receipt cost. It covers direct transactions from the bot with no access or authorization list. Rollup fees charged separately from EVM gas and caller-contract overhead are not covered. Local gas estimation, fee refresh, token conversions and profitability filters still run as before; no extra submission RPC is needed.

Split execution retains branch minimum outputs and a thirty-second deadline because later stages spend fixed amounts. Neither entry point accepts a quoted-profit minimum. A revert still costs gas, and a positive surplus in a non-native token does not guarantee profit after gas. Pool addresses come from configuration and the signed plan, not an on-chain factory allowlist.

Events update the main graph before searches are queued. One search runs at a time; pending requests coalesce by market. Reserve changes, V3 liquidity deltas and Carbon strategy changes are applied before that coalescing, not thrown away with an older search request. The worker receives compact changes after its initial full snapshot. A failed or timed-out worker produces no trades, and the next scan starts from the current graph.

A quote carries route-pool, funding-pool and feed revisions. Checks after search, before signing and before broadcast reject changed dependencies. An unrelated pool event does not invalidate a V2/V3 quote. An event changing one of its pools does, even if the quote is only 100 ms old. Carbon invalidation is broader. Any Carbon change invalidates Carbon candidates. Independently, the current 500 ms `candidateMaxAgeMs` rejects a quote that has aged out even with unchanged pools. Disconnects pause acceptance until reconciliation. None of this closes the gap between broadcast and inclusion.

Submission locks route pools until their next applied market update or the thirty-second timeout. Carbon locks are controller-wide. The fee snapshot, chain ID, calldata, gas limit and nonce are supplied locally; the normal signing path does no fee, nonce, gas-estimation or transaction-preparation RPC. The network call is the raw-transaction submission itself.

Use a dedicated wallet and one bot process. Execution startup reads its pending nonce once, then allocates locally. Background reconciliation runs every twelve hours. A known-unsubmitted nonce can be released after signing/freshness failure; an attempted submission with an uncertain outcome pauses new submissions and triggers immediate reconciliation, retrying every five seconds. Trading resumes only after pending advances past all uncertain nonces. A rejected or dropped transaction can need operator intervention; the bot does not cancel it, replace it or replay an old opportunity automatically. Inspect pending transactions before restarting.

After the RPC returns a transaction hash, the bot queues a Telegram alert with that hash and an explorer link when one is configured. It does not request transaction receipts or report confirmations and reverts. Check the explorer for the outcome. Signing and submission failures that happen before a hash is returned are still reported.

## Logs and alerts

Set `RUNTIME.logLevel` to `off`, `info` or `debug` and restart. The checked-in value is `info`. Info includes startup progress, quote counts, submission notices and compact latency summaries. Debug adds sized-candidate diagnostics, rejected profit checks, paths, split allocations, execution plans and error stacks. Off disables routine logging and latency collection, but not freshness checks or configured Telegram alerts.

A separate reporting worker formats output and sends Telegram through `src/reporting/telegram.ts`. The trading thread never awaits it. It still copies bounded records, so enabled logging has allocation and CPU cost. The queues hold 256 routine records and 32 alerts, with bounded in-flight batches; overload drops diagnostics instead of blocking trades. Debug is not a lossless trade ledger. Secrets and signed payloads are redacted, but do not intentionally pass credentials to the logger.

Alerts for submission, feed/fee/nonce problems and fatal errors use the existing Telegram fields. Repeated incident keys are throttled; different transaction hashes remain separate. Delivery has timeouts, at most one retry and rate-limit handling. A timed-out delivery may be duplicated by its retry. `Reporting health` exposes drops and delivery failures.

Reporting-worker failure disables reporting without stopping trading. Fatal shutdown stops execution first and allows a bounded two-second cleanup/reporting window. A killed process, dead worker or failed machine cannot guarantee a Telegram alert; detecting that needs an external supervisor.

Latency summaries normally appear every minute. Counts are cumulative; percentiles use the last 512 samples per stage, with p95 withheld until 20 samples and p99 until 100. Check `search.expired`, `search.invalidated` and `split.budgetStops` before assuming a missing result is a quote-calculation bug. SQLite checkpoints and reporting allocations still share CPU or the main event loop; workers do not make their overhead disappear.

## Checks and local tools

```sh
bunx tsc --noEmit
bun test
forge test
```

Bun tests use synthetic markets and mocked clients; Foundry tests use local mock contracts. Neither is deployed-pool validation. Foundry settings are pinned in `foundry.toml`, including Solidity 0.8.27 and `via_ir`. Contract or protocol changes still need fork validation against the intended deployments.

`bun run test:stress` runs V2-only and mixed V2/V3 graph cases. `V2_STRESS_PAIRS` and `V2_STRESS_SEARCH_LIMIT_MS` tune the V2 case; the scheduler burst test in `bun test` accepts `V2_STRESS_UPDATES`. Shared ordinary-token fixtures include synthetic zero-tax observations; unsupported and expired tax cases have their own tests.

The `bench:stress`, `bench:carbon`, `bench:split` and `bench:reporting` scripts are local measurements, not profitability estimates. Reporting runs with Telegram disabled and measures caller overhead, drops and heap/GC observations. Lower latency under saturation can mean logs were discarded. The current split benchmark builds pools without transfer profiles, so with profiling enabled its zero winners do not exercise successful split allocation.

`bun run replay:split recording.ndjson` reads recorded graph frames without a client, signer or executor. Supply your own file; none is bundled. Each line is `{ at, changes, startTokens, costs }`: first a full graph snapshot, then deltas, with contemporaneous cost data. Encode bigints using `replayJSON.stringify` in `src/opportunities/split-replay.ts`. Replay enables split search and uses the existing `TOKENS`/`topTokens` selection. It rebases cost expiry, but not transfer-profile expiry, so old profiles remain ineligible. Its optional V2 fill model checks token surplus but cannot reproduce the contract's measured-gas check. Repeated quotes are observations, not independent revenue; this is not a P&L backtest.

For a missing market, check the complete catalog versus the filtered list, bans, liquidity/activity rules, V3 coverage and profile expiry. For quotes without submissions, check the master execution switch, funding pool, fee/conversion validity, freshness, locks and nonce recovery. `No markets for enabled protocols` usually means the selected protocols need sync or startup is using a different database path.

When adding an adapter, start with `src/protocols/protocol-plugin.ts`. Discovery, graph quotes, events and execution encoding must agree; keep its registry contract ID, Solidity support and generated ABI in sync. Editing TypeScript alone cannot add a protocol to a deployed executor.

MIT licensed; see [LICENSE](LICENSE).
