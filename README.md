# ArbitrageV

ArbitrageV is a working Bun/TypeScript bot that finds and executes arbitrage on EVM chains. It keeps pool state in memory, searches direct and split routes, and submits through NArb using V2/V3 funding. It supports V2 constant-product pools, compatible Solidly stable/volatile pools, Uniswap V3 and Carbon. This is also a learning project. Local profitability is a quote, not a promise of successful inclusion or realized profit.

## Running it

Use Bun; the runtime depends on its workers and SQLite APIs. Copy [.env.example](.env.example) to `.env`, install with `bun install`, and review [src/constants.ts](src/constants.ts) before starting.

**The current configuration enables execution.** Set `EXECUTION_POLICY.executeTrades = false` for a read-only run. The configured chain is Cronos, with V2-only routing, transfer profiling enabled, split search enabled and predicted follow-ups disabled. Logging is off, so set `RUNTIME.logLevel = 'info'` if you want startup progress.

- `RPC_URL` and `UNISWAP_FLASH_QUERY_CONTRACT_ADDRESS` are required for market sync.
- `ARB_CONTRACT_ADDRESS` is required for execution and V2 transfer profiling, including profiling during sync.
- `PRIVATE_KEY` is required by startup even with execution disabled. Sync does not need it.
- `WSS_URL` enables WebSocket events. Initialization failure falls back to HTTP.
- `MARKET_DB_PATH` overrides `data/markets-<chainId>.sqlite`.
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` enable alerts. Leave both blank to disable them.

Deploy contracts matching the source. [Contract/NArb.sol](Contract/NArb.sol) defines `ArbitrageExecutor(owner, wrappedNativeToken)`; its owner must be the signing wallet. The constructor deploys immutable V2, V3 and Carbon logic contracts. NArb delegates swaps to them but retains custody, callback validation, repayment and profit checks. These modules are not upgradeable and should not hold funds themselves.

The modular executor needs a new deployment if you were using the older monolithic contract. Set its address in `ARB_CONTRACT_ADDRESS` and refresh transfer profiles, which are executor-specific. The query contract is `FlashUniswapQueryV1` in `Contract/UniswapFlashQuery.sol`. An existing query deployment with the transfer-profiling functions can still be used.

`forge build` compiles the contracts. `bun run abi:arb` regenerates both query and executor JSON ABIs from `out/forge`. Neither command deploys anything.

After configuring the contracts and tokens:

```sh
bun run sync:markets
bun start
```

Sync stores market metadata and transfer observations. Startup subscribes in buffering mode, hydrates current state, warms the search worker, then reconciles buffered events before trading. A full profile pass or V3 tick download can take minutes. Stop with `Ctrl+C`.

## Tokens, wrappers and protocol selection

`ARBITRAGE_SEARCH_POLICY.allowedProtocols` controls discovery, live loading, events and search. Use one protocol, any two, or all three: `['v2']`, `['v2', 'v3']`, or `['v2', 'v3', 'carbon']`. Keep at least one. There is no registry edit needed to disable an existing protocol.

There is one current restriction: `V2_LIVE_POLICY.transferFees: true` requires V2-only routing. To enable V3 or Carbon, turn profiling off in `src/protocols/v2/config.ts` and use tokens compatible with untaxed quotes. V3 and Carbon tax profiling is not supported yet; a V2 observation does not establish compatibility with either.

Define native wrappers once in `WRAPPED_NATIVE_TOKENS`, with their name, address, decimals and liquidity threshold. Put ordinary tokens in `TOKENS`. The bot derives `CONFIGURED_TOKENS` from both lists at startup, wrappers first, and uses it for filters, search and display metadata. Duplicate addresses stop startup or sync.

The first wrapper is canonical and must match NArb's constructor argument. Other entries must be verified WETH9-compatible, 1:1 wrappers of the same native coin and approved by the owner with `setWrapper(address, true)`. Configuration does not audit a contract. Startup checks approvals when execution is enabled and multiple wrappers or the new execution modes are configured. WBTC and bridged WETH on Cronos are ordinary tokens, not CRO wrappers.

Wrappers remain separate graph tokens. A route can start with wrapper A and finish with wrapper B; NArb withdraws B to native currency and deposits into A before repayment. Even a single pool trading A for B can form a route this way. The contract requires exact token and native balance changes. Tokens with redemption fees, withdrawal queues or non-1:1 conversion do not belong in this list.

Configured tokens present in the graph fill the preferred starting slots up to `topTokens`, currently three. With the current two wrapper entries, those slots are the two WCRO addresses followed by VVS, if all are available. Remaining slots are filled from graph tokens ranked by locally quoted native-value capacity. `TOKENS: []` is valid and keeps wrapper preferences. Intermediate tokens need no configuration entry.

Selection is reconsidered when the graph's token count changes or `tokenSelectionRefreshMs` elapses, currently 24 hours. This caches the starting-token selection, not token prices. Automatic tokens without metadata are reported as addresses and raw amounts.

`ARBITRAGE_SEARCH_POLICY.minProfitNative` is the shared minimum after the conservative gas allowance, currently `tokenAmount('0.09')`. An entry in either token list can override it:

```ts
liquidityAmount: tokenAmount('10', 6), // 10 units of this six-decimal token
minProfitNative: tokenAmount('0.2'),   // 0.2 native coins, not 0.2 of this token
```

Liquidity thresholds filter loaded markets; they are not trade sizes. Profit overrides use native wei regardless of the token's decimals.

Factory addresses stay with their protocols: `V2_FACTORIES` in `src/protocols/v2/config.ts`, `V3_FACTORIES` in `src/protocols/v3/config.ts`, and `CARBON_CONTROLLERS` in `src/protocols/carbon/config.ts`. V2 fees use basis points, so 30 means 0.30%; V3 fees use parts per million, so 3000 means 0.30%. Solidly fees are read from its factory. V3 `fromBlock` is inclusive and must be at or before deployment for complete discovery.

Restart after changing configuration. Resync protocols whose discovery settings changed:

```sh
bun run sync:markets --protocol v3
bun run sync:markets --protocol v2 --protocol carbon
```

No arguments means the configured protocols; `--all` selects all three. Explicit sync selection preserves other protocols' stored markets and does not enable them at runtime. Carbon discovery uses the V2/V3 token universe, including stored markets when syncing Carbon alone.

Changing chains also means reviewing wrappers, tokens, factories/controllers, bans and deployments, not just replacing the RPC URL. Set `NETWORK.chain` to the full viem chain definition. HTTP chain-ID mismatch stops startup or sync; a mismatched WebSocket endpoint falls back to HTTP. SQLite catalogs are chain-bound and cannot be relabeled for another chain. Algebra, dynamic-fee V3 forks, non-EVM chains and cross-chain trades are outside the current adapters.

## What sync saves, and what startup still reads

The database separates complete discovery catalogs and checkpoints from the filtered trading list. Disabling a protocol does not delete its discovery history. Different factory, database and live-pool counts are expected.

V2 reads factory counts and fetches new pair indexes after its checkpoint. Configuration changes, count rollbacks or checkpoint reorgs rebuild the affected factory. V3 scans `PoolCreated` logs across fee tiers, then batches immutable metadata through FlashQuery. This phase saves tokens, fee, tick spacing, creation block and legal bitmap bounds.

V3 startup then reads price, active liquidity, every legal bitmap word and every initialized tick, pinned to one block per snapshot. It can quote across multiple initialized ticks; it does not download individual LP positions. Pagination is controlled by `V3_STARTUP_POLICY`, not a fixed total-tick cap. Interrupted downloads keep a cursor but never enter the graph as partial snapshots.

Completed V3 snapshots have a block hash. Restart validates it and catches up events; reorgs or unavailable history require a fresh snapshot. Swap, Mint and Burn events update local state. Invalid ordering, removed logs and inconsistent liquidity make the affected pool unavailable until recovery. V3 also rotates checkpoints: ten pools per batch, normally every sixty seconds, with five-second recovery retries. This is not a full refresh of every pool each minute.

Carbon loads controller pairs and strategies. Creation, update and deletion events produce strategy deltas for the worker after its initial snapshot. Only affected pair directions are rebuilt. Grouped Carbon quotes consider at most eight orders, identified by controller and strategy ID.

V2/V3 factory events trigger new-pool discovery immediately. The shared `RUNTIME.marketDiscoveryIntervalMs`, currently four hours, catches missed creation events. Unchanged V2 checks do not refetch/filter the full catalog or repeat its full discovery summary. New pools are subscribed before hydration.

The shared filter applies `src/bannedtax.json` and normally requires both tokens to appear in multiple markets; a pair between configured native wrappers can stand alone. V2 also checks positive reserves, configured liquidity thresholds and activity. When neither token is configured, either reserve must meet `V2_DISCOVERY_POLICY.minOtherTokenLiquidity`, currently `tokenAmount('500')`. This is a raw-unit comparison with no decimal adjustment. Add a token to the configuration for its own threshold; configured pairs bypass the fallback. V3 needs complete coverage; Carbon has its own liquidity filter.

The RPC must support block-pinned reads and complete logs. Range-limit errors can be retried in smaller batches. Silent truncation cannot be repaired if both live events and historical logs omit the same updates.

## Transfer taxes

A tax profile describes a pool/token/executor/origin context, not a universal token percentage. Buy, sell and external transfers are measured separately and stored in SQLite's `v2_transfer_profiles`.

FlashQuery batches unsigned `eth_call` probes through NArb. The probe borrows a sample, measures pool-to-NArb receipt, transfers part to the owner and sends the remainder back to the pool. It deliberately reverts with measurements so the next probe starts from unchanged state. These are RPC simulations, not transactions; they spend no wallet gas. The external-transfer measurement only describes NArb sending to its owner, not arbitrary recipients.

With profiling enabled, both direct and split V2 routes return proceeds to NArb between hops. Each quote applies the input token's sell deduction, the pool's swap math and fee, then the output token's buy deduction:

```text
NArb sends 100 X
  10% sell deduction -> pool receives 90 X
  pool quote for 90 X, including swap fee -> 200 Y
  22% buy deduction -> NArb receives 156 Y
next hop starts with 156 Y and uses that next pool's profile
```

The numbers are illustrative. We do not add buy and sell percentages to approximate an unmeasured pool-to-pool transfer. Custody costs more gas but matches the probed transfer paths. With profiling disabled, consecutive direct V2 hops can forward pool-to-pool and quotes assume no tax.

The executor calculates effective V2 input from `balanceOf(pool) - reserveIn` and output from the recipient's balance increase. Extra sender debits are rejected. A token returning `true` or emitting the requested `Transfer` amount does not establish actual receipt.

Samples range from 1/100,000,000 to 1/4 of the reserve. A usable estimate needs at least two distinct amounts, exact sender debits, positive credits and deduction rates agreeing within one basis point. Quotes use the largest rounded-up measured deduction and reject amounts outside the observed range. Unknown, expired or unsupported profiles are not zero-tax profiles. External flash borrowing also requires zero buy/sell deductions on its funding pool and measured bounds covering borrowing and repayment.

Sync and startup fill missing or expired profiles. Current cached profiles are reused after block-hash validation. Background refresh is scheduled for the earliest expiry, currently four hours after observation, or for a newly hydrated pair without a profile. A long probe pass shares an observation time, so expiry can cause another large pass. Failed refreshes retry after a minute; expired profiles remain ineligible. New profiles merge into current reserves without overwriting intervening events.

There are no probe RPCs during search, signing or submission. These measurements still cannot predict changing exemptions, untested thresholds, rebases or token-triggered swaps. A sell-transfer probe does not prove a complete sell swap succeeds. Validate unfamiliar token routes on a fork before executing them.

## Direct routes, splits and follow-ups

Direct search visits bounded paths, ranks candidates and sizes them with integer quotes. Current limits include five edges, 50,000 exploration attempts and 64 candidates to size. `maxInputReserveFraction: 10n` caps opening input at one tenth of the relevant capacity. These limits trade coverage for latency; the search is not exhaustive.

`splitRouting: 'off'` skips split search. `'live'` adds it after direct search and retains direct results. `executeTrades: false` prevents both from submitting.

A split stage converts one token into another using one or two pools, then merges proceeds. A plan has two or three stages, at most six swaps and at least one two-branch stage. For example, ignoring fees and taxes:

```text
                   100 A -> pool 1 -> 181 B
borrow 200 A -----<                        >----- 362 B -> pool 3 -> 306 A
                   100 A -> pool 2 -> 181 B

Two stages, three swaps. Repay 200 A; 106 A remains before costs.
```

A three-stage plan can be `A -> B -> C -> A`, with two branches per stage for six swaps. Branches in a stage must share the same input and output tokens; different intermediate-token paths are not supported. Pool or Carbon-strategy liquidity cannot be reused within a split plan, and its funding pool must be outside the route.

Split search takes short paths from direct discovery before its profit filter, tries pool subsets and allocations, and returns at most one winning split per start token alongside direct results. Both use native-denominated profit ranking. Signed amounts and minimum outputs are fixed. `EXECUTION_POLICY.slippageBps`, currently 5, reduces each split branch's quoted output; later stages spend the minimum proceeds, not favorable leftovers.

`splitSearchMs` gives split search ten extra milliseconds. Direct and split work share a worker job, so split work delays its return. Budget checks are cooperative; one quote, tick walk or GC pause can overshoot. `split.budgetStops` means exploration ended early, not that no profitable split exists. `split.work` counts search work, not trades.

Predicted follow-ups are a separate feature controlled by `EXECUTION_POLICY.followUpMode`:

- `off`: no predicted successor.
- `separate`: prepare A and B with consecutive nonces, submit A, then submit B after A's RPC acknowledgement if its freshness checks still pass. It does not wait for events or receipts.
- `batch`: send one `executeBatch([A, B])` transaction. A's funding call returns before B starts, allowing B to reuse its pools. If B fails, A rolls back too.

The worker projects the highest-ranked candidate's pool changes and searches for one successor with the same start token. `followUpSearchMs` gives this search a shared ten-millisecond budget. It restores the observed graph afterward; submission never advances authoritative reserves. Projection supports V2 reserves, V3 tick/price/liquidity changes and Carbon inventory changes. Solidly assumes the supported fee-out-of-pair convention. Taxed routes can execute but do not seed successors, because transfer samples cannot predict arbitrary token side effects.

If A creates a price difference that makes B profitable, `separate` requires each to clear its own cost floor. Consecutive nonces preserve our order, not adjacency or A's success: a competitor may consume B's opportunity between them. `batch` compares combined surplus after one batch gas allowance with A alone. It permits no intervening transaction, but a revert still costs gas. This is one-step prediction, not a joint optimizer or an inclusion guarantee.

## Funding, gas and profit

Ordinary routes use an enabled V2/V3 lender outside their swap pools. Carbon cannot lend, so Carbon-only routing has no executable funding source. `allowProtocolMixing: false` restricts swaps, not the funding protocol.

`routeSwapFunding: true` lets an eligible direct route use its first V2/V3 swap as funding. For `A -> B -> C -> A`, that pool sends B first; NArb trades back to A, then pays A in the callback. This is opposite-token swap repayment. V3's separate `flash()` still repays in the borrowed token. The first pool stays locked until repayment and cannot reappear later in the route.

Profiled V2 first-swap funding requires zero measured sell deduction at the chosen input size; V3 requires complete tick coverage and full input consumption. Unsupported first hops, taxed first inputs and splits use an external lender. General swap-funded routes use `executePlan`; the compact `executeV2RouteFlash` remains for older all-volatile-V2 callers and shares the implementation. Funding selection is not an exact gas optimizer.

Gas limits have one configuration and one resolver:

```ts
gasLimits: {
    single: 1_500_000n, // Direct, split, or each transaction in separate mode.
    batch: 3_000_000n,  // A and B in one transaction.
}
```

Search charges this allowance at the cached fee cap; signing uses the same limit. There are no per-chain or funding-path overrides. These limits are not measured per opportunity, and a route may exceed them. Measure against the deployed contract before lowering them. Gas limit is not gas used.

Fees are estimated at startup and every `feeRefreshIntervalMs`, currently five minutes. `legacy: true` uses `gasPrice`; `false` uses EIP-1559 maximum and priority fees. Failed, invalid or above-ceiling estimates retain the last valid quote until its original expiry, twice the refresh interval. They never extend it. Without a valid quote, searches and submissions pause while market events continue. An old fee cap may leave a transaction pending. Expiry itself has no immediate pause alert; a later failed refresh reports it.

`profit` is start-token surplus after repayment, before gas. `netProfitNative` values that surplus in native wei and subtracts the gas allowance. Wrappers use the configured 1:1 assumption. Other tokens are valued by quoting the actual surplus through at most two local swaps, considering eight ranked edges per step, then taking a 0.5% haircut. Valuation uses projected route state where supported; otherwise it excludes route and funding pools. No conversion path means no eligible quote.

This valuation uses current graph state, fees, deductions and price impact, not an external oracle or a frozen daily price. It does not sell the profit token for you. Shallow or manipulated markets and unsupported token behavior can make it unreliable.

NArb protects pre-existing start-token inventory and requires positive surplus after repayment. For approved wrappers it also checks gas using `tx.gasprice`, measured execution, 21,000 intrinsic gas, 16 gas per calldata byte and 10,000 overhead. It takes the larger result versus `21,000 + 40 * calldataBytes` for the calldata floor. It treats bytes as nonzero and ignores refunds, so this is conservative rather than an exact receipt cost. Separate rollup fees and caller-contract overhead are not covered.

`NoProfit()` means no surplus; `InsufficientProfitAfterGas` means wrapper surplus failed that gas check; `InsufficientFlashLoanRepayment()` means repayment would consume old inventory. Non-wrapper on-chain checks do not establish profit after gas. No entry point enforces the quoted minimum profit. Split and general plans have deadlines, and split branches retain minimum outputs. Pools are supplied in signed plans, not checked against an on-chain factory allowlist.

## Freshness and submission

Events update the main graph before search requests coalesce by market. Only one search runs at a time; combining queued requests does not discard their state updates. The worker receives deltas after its initial snapshot. Failed or timed-out workers produce no trades and rebuild from current state.

Quotes carry route, funding, valuation and feed revisions. Checks after search, before signing and before broadcast reject changed dependencies. An unrelated V2/V3 event does not invalidate a quote. A change to a pool it uses does, even at 100 ms old. Any Carbon change invalidates Carbon candidates, including those using another controller. Separately, `candidateMaxAgeMs`, currently 500 ms, expires old results even with unchanged pools. Disconnects pause acceptance until reconciliation. These checks cannot prevent changes after broadcast.

Submitted route pools, including a prepared successor's pools, stay locked locally until their next applied update or a thirty-second timeout. A failure to submit B does not release already-submitted A's locks. External lenders can serve disjoint routes; locks do not reserve flash capital. Carbon locks are controller-wide.

Use one bot process and a dedicated wallet. Execution reads the pending nonce at startup and allocates locally, refreshing every twelve hours. An uncertain send pauses new submissions and reconciles immediately, retrying every five seconds until pending advances past all uncertain nonces. A known-unsubmitted nonce can be released. A rejected or dropped transaction may require operator intervention; the bot does not replace, cancel or replay it automatically. Inspect pending transactions before restarting.

The normal signing path uses cached fees, local nonces and prepared calldata. It does no fee, nonce, gas-estimation or transaction-preparation RPC. Raw transaction submission is the network call. Factory discovery, fee refresh, profile refresh, V3 checkpoints and feed recovery still use RPC in the background.

After submission returns a hash, the bot queues a Telegram message with an explorer link when configured. It does not poll receipts or report later confirmations/reverts. The reported profit is expected, not realized. Signing and submission errors before acknowledgement are still reported.

## Logs and offline checks

`RUNTIME.logLevel` accepts `off`, `info` and `debug`. Info shows startup progress, quote counts, submissions and compact latency summaries. Debug adds routes, sizing/profit diagnostics, split allocations, execution plans and stacks. Off disables routine logging and latency collection, not freshness checks or configured Telegram alerts.

A reporting worker formats logs and sends Telegram through `src/reporting/telegram.ts`. Trading never awaits it, but copying records still costs CPU and allocations. Queues hold 256 routine records and 32 alerts with bounded in-flight batches. Overload drops records; debug is not a lossless ledger. Repeated incident alerts are throttled, transaction hashes remain distinct, and delivery has timeouts, rate-limit handling and at most one retry. A timeout followed by retry can duplicate an alert.

`Reporting health` exposes drops and delivery failures. Reporting-worker failure does not stop trading. Shutdown gives reporting a bounded two-second window; a killed process or failed machine cannot guarantee an alert. Use an external supervisor for that.

Latency summaries run every minute when enabled. Counts are cumulative; percentiles use the last 512 samples, with p95 available after 20 and p99 after 100. Check `search.expired`, `search.invalidated` and `split.budgetStops` when results disappear. Workers do not remove main-thread copying or SQLite work.

```sh
bunx tsc --noEmit
bun test
forge test
```

Bun tests use synthetic markets and mocked clients; Foundry uses local mock contracts. Neither validates deployed pools. [foundry.toml](foundry.toml) pins Solidity 0.8.27, the Paris EVM target and IR compilation. Protocol or contract changes still need fork validation.

`test:stress`, `bench:stress`, `bench:carbon`, `bench:split` and `bench:reporting` measure local behavior, not profitability. `V2_STRESS_PAIRS` and `V2_STRESS_SEARCH_LIMIT_MS` tune the V2 stress case; `V2_STRESS_UPDATES` controls the scheduler burst test. The split benchmark currently has no transfer profiles, so zero winners with profiling enabled do not exercise successful split allocation. Reporting benchmarks disable Telegram; lower latency under saturation may mean records were dropped.

`bun run replay:split recording.ndjson` reads your recorded graph snapshots/deltas without creating a network client or signer. No recording is bundled. Each line is `{ at, changes, startTokens, costs }`; begin with a full snapshot and encode bigints using `replayJSON.stringify` in `src/opportunities/split-replay.ts`. Replay uses the frame's starting tokens, not live automatic selection. It rebases cost expiry but not transfer-profile expiry. Repeated quotes are observations, not independent revenue, and its local V2 fill model does not reproduce NArb's gas check.

For missing markets, check bans, filters, profile expiry, V3 coverage and the selected database. For quotes without submissions, check execution settings, funding, native valuation, cached fees, freshness, locks and nonce recovery. When adding a protocol, start with `src/protocols/protocol-plugin.ts` and keep discovery, quote math, events, contract IDs, Solidity support and generated ABIs consistent.

MIT licensed; see [LICENSE](LICENSE).
