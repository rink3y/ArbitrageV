# ArbitrageV

An arbitrage bot for compatible EVM networks, written in TypeScript and run with Bun. It looks for circular trades across V2 pools, V3 pools, and Carbon strategies, and can execute them using a flash loan from a V2 or V3 pool. The supplied chain, token and DEX settings are for Sei.

V2 and V3 pools are discovered from factories. Carbon pairs come from the configured controllers. You choose which protocols to use in `src/constants.ts`.

## Getting started

You'll need Bun, an HTTP RPC endpoint for your chosen chain, and a deployed query contract matching [UniswapFlashQuery.sol](Contract/UniswapFlashQuery.sol). To submit trades, you'll also need a deployed [arbitrage contract](Contract/NArb.sol) and a wallet with the chain's native currency for gas. Contract deployment isn't included in the setup commands.

From the repository root:

```sh
bun install
```

Copy [.env.example](.env.example) to `.env` and fill in your RPC URL, private key, and contract addresses. Keep an existing `.env` if you've already configured one.

Before starting, check `EXECUTION_POLICY` in [src/constants.ts](src/constants.ts). The current default is `executeTrades: true`. To watch for opportunities without sending transactions, change it to:

```ts
executeTrades: false,
```

The bot still requires a valid private key in this mode because startup creates a wallet client. The market sync command does not need one.

Then run:

```sh
bun run sync:markets
bun start
```

Sync builds the market list in `data/markets-<chainId>.sqlite`. Startup loads that list, fetches current market state, and begins watching for changes. Stop the bot with `Ctrl+C`.

To refresh one protocol without querying or removing the others, select it on the command line:

```sh
bun run sync:markets --protocol v3
bun run sync:markets --protocol v2
bun run sync:markets --protocol carbon
```

Repeat `--protocol` to refresh several protocols, or use `--all` to refresh all three:

```sh
bun run sync:markets --protocol v3 --protocol carbon
bun run sync:markets --all
```

With no command-line selection, sync refreshes the protocols in `ARBITRAGE_SEARCH_POLICY.allowedProtocols`. Every run preserves stored markets for protocols it did not select. Carbon-only discovery uses the stored V2 and V3 markets as its token universe.

### The .env file

| Variable | What it does |
| --- | --- |
| `RPC_URL` | HTTP RPC endpoint, required for both sync and startup. |
| `PRIVATE_KEY` | Wallet private key, required for startup even when trading is disabled. |
| `WSS_URL` | Optional WebSocket endpoint. Leave it unset to receive market events through HTTP. |
| `UNISWAP_FLASH_QUERY_CONTRACT_ADDRESS` | Deployed query contract used for market discovery and batch reads. |
| `ARB_CONTRACT_ADDRESS` | Deployed contract used to execute trades. |
| `MARKET_DB_PATH` | Overrides `data/markets-<chainId>.sqlite`. Each catalog file is bound to one chain. |
| `DEBUG` | Set to `true` to see detailed market, opportunity, and transaction logs. |
| `TELEGRAM_BOT_TOKEN` | Bot token for transaction notifications. |
| `TELEGRAM_CHAT_ID` | Chat receiving those notifications. Leave both Telegram fields blank to disable them. |

## Switching networks

Edit `NETWORK` in [src/constants.ts](src/constants.ts). Set `chain` to the full definition imported from `viem/chains`, and `wrappedNativeToken` to that chain's wrapped native currency contract. For a custom EVM network, use viem's `defineChain` in the same file. There is no separate chain ID to keep in sync. Clients, signing, explorer links, native-token aliases and split gas conversion use these settings.

Also replace `TOKENS`, the enabled V2/V3 factories and Carbon controllers, and any chain-specific entries in `src/bannedtax.json`. Set the new RPC endpoints and deployed contract addresses in `.env`. Disable protocols that do not have a supported deployment on the new chain. A matching protocol name alone does not establish compatible contract behavior.

Deploy `ArbitrageExecutor(owner, wrappedNativeToken)` from [NArb.sol](Contract/NArb.sol), using the same wrapped-token address as `NETWORK.wrappedNativeToken`. The wrapper must implement standard `deposit()` and `withdraw(uint256)` with 1:1 native-unit accounting. This constructor replaces the old owner-only constructor, so existing deployments need replacement to use this implementation. Regenerate the ABI with `bun run abi:arb` after building. No command here deploys a contract automatically.

Sync and startup check the HTTP RPC chain ID before using markets. A mismatched WebSocket endpoint falls back to HTTP. These checks run at initialization, not for each trade. With no explorer configured in the chain definition, notifications show the transaction hash without a link.

The default database path changes with the chain ID. An explicit `MARKET_DB_PATH` pointing at another chain's catalog is rejected. Old unbound catalogs such as `data/markets.sqlite` are left untouched and rejected rather than assigned a guessed chain. Unset that override or choose a fresh path, then run `bun run sync:markets` to rebuild the list.

Set `EXECUTION_POLICY.executeTrades = false` while configuring a new network. Review token thresholds and the legacy/EIP-1559 gas settings, sync, and validate against that network before enabling trades. Portability covers compatible EVM networks and the existing protocol adapters, not non-EVM chains, arbitrary DEX forks or cross-chain arbitrage. Split cost estimates cover execution gas only; additional chain-specific fees, such as L1 data fees on some rollups, are not modeled. Leave split live execution off on those networks until those costs are accounted for.

## Switching protocols

Change `ARBITRAGE_SEARCH_POLICY.allowedProtocols` in [src/constants.ts](src/constants.ts). For V2 only:

```ts
allowedProtocols: ['v2'],
```

Add `'v3'` or `'carbon'` to enable them. All three are enabled by default. Keep at least one in the list.

This setting controls discovery, startup reads, event subscriptions, and route searches. Removing a protocol takes effect on restart, even if its old market entries are still in SQLite. No registry edits are needed.

When adding a protocol back, refresh that protocol before restarting. For example, run `bun run sync:markets --protocol v3`. Markets belonging to unselected protocols remain in SQLite and are still ignored at runtime while disabled.

`allowProtocolMixing: false` restricts each swap route to one protocol. It doesn't disable any protocol, and the flash loan can still come from another enabled protocol.

Carbon can be part of a swap route but cannot provide the flash loan. The execution planner needs a V2 or V3 funding pool outside the route, so enabling only Carbon won't produce executable trades.

## Factories, pools, and controllers

### V2

Edit `V2_FACTORIES` in [src/protocols/v2/config.ts](src/protocols/v2/config.ts). Each entry needs a name, factory address, fee, and kind. The supported kinds are `uniswap-v2` and `solidly`.

The fee uses basis points: `30` means 0.30%. For Solidly pools, discovery reads the stable and volatile fees from the factory.

V2 discovery does not scan historical blocks. It reads each factory's current pair count and fetches only indexes after the saved checkpoint. The complete discovered catalog and the per-factory pair count are stored in SQLite. If the checkpoint block changes in a reorg, or the factory configuration changes, that factory is rebuilt from index zero.

### V3

Edit `V3_FACTORIES` in [src/protocols/v3/config.ts](src/protocols/v3/config.ts). Each entry needs a name, factory address, inclusive `fromBlock`, and `enabled` flag. There is no manual pool list. Sync reads every `PoolCreated` event from each enabled factory through the chain head observed when the sync starts, including every fee tier.

The defaults cover [Dragon's concentrated-liquidity factory](https://docs.dragonswap.app/dragonswap/faq/contract-addresses/dragonswapv2), [Uniswap on Sei, available through Oku](https://gov.uniswap.org/t/official-uniswap-v3-deployments-list/24323), and [Sailor's factory](https://seiscan.io/accounts/label/sailor). The adapter supports standard Uniswap V3 reads and events plus [Sailor's extended Swap event](https://seiscan.io/address/0xa77386b7CB41a5693a0A5Ad34b6bDEB9237F35eE). It does not support Algebra or dynamically changing fees.

The configured `fromBlock` must be at or before the factory deployment if you want every pool. The first scan can take a while. Later scans resume from saved checkpoints. `V3_DISCOVERY_POLICY` controls the block span and metadata batch size. V3 fees use parts per million: `3000` means 0.30%.

### V3's two phases

`bun run sync:markets --protocol v3` runs phase 1 without querying V2 or Carbon. It saves each pool's factory, creation block, token addresses, fee, tick spacing, and full bitmap bounds. Factory events find the addresses; the query contract checks their immutable fields in batches. The complete V3 catalog stays in SQLite even when a pool fails the trading filters. Later V3 scans begin at each factory's saved checkpoint plus one and stop at the chain head captured at the start of that scan.

`bun start` runs phase 2 for the selected trading pools. It reads price, current tick, active liquidity, every bitmap word in the pool's legal tick range, and every initialized tick. All reads for a snapshot use the same block. Tick liquidity and actual occupied ranges are mutable, so they belong here, not in phase 1. This loads pool liquidity, not individual LP wallets or NFT positions.

The range is no longer a few words around the current price, and there is no 512-tick total cap. Reads are paginated. `V3_STARTUP_POLICY` sets page sizes, batch sizes, concurrency, and catch-up spans. Lower these if the RPC rejects large calls. Failed multi-item reads and log ranges are split into smaller requests.

Completed snapshots store their block number, block hash, and full-range coverage. Interrupted downloads save a separate cursor and resume at their original block; they are never admitted to the trading graph. On restart, the bot checks the saved block hash and catches up missed events. Swaps refresh live state; mints and burns refresh their affected tick boundaries. Burned-out ticks are removed. A reorg or unavailable history triggers a fresh snapshot. Failed pools stay out of the graph until a refresh succeeds.

Once live, V3 does not call the query contract for every event. Swap events update price, tick, and active liquidity in memory. Mint and Burn events update both tick boundaries, their bitmap bits, and active liquidity when the position covers the current tick. Exact duplicate logs are ignored. Removed logs, conflicting block hashes, unexpected ordering, missing cursors, and liquidity inconsistencies exclude the affected pool until recovery succeeds.

### New pools while the bot is running

V2 and V3 factory feeds stay active after startup. A factory event triggers a checkpointed catch-up rather than trusting one notification as the source of truth. The bot also checks both factory catalogs every `RUNTIME.marketDiscoveryIntervalMs`, which defaults to 60 seconds, so a dropped subscription notification is repaired without a restart.

Discovery and live state remain separate. First, the new pool's immutable metadata is saved in the complete catalog. The shared V2/V3/Carbon token filter is then recalculated and the filtered trading list is written to SQLite. If the pool is selected, its event subscription is installed before its current state is loaded. V2 buffers `Sync` logs while reading block-pinned reserves; V3 publishes only after a complete full-range snapshot and event catch-up. A failed hydration leaves the pool out of the graph and retries on a later catch-up.

The same path handles removals caused by a factory reorg or a filter change. The pool is removed from the main graph and the search worker through an explicit removal patch. Adding one pool can also make another previously filtered V2 or V3 pool eligible, because filtering is rerun across the complete live catalogs.

`V3_LIVE_POLICY` in [src/protocols/v3/config.ts](src/protocols/v3/config.ts) controls rotating checkpoints: 10 pools per batch, normally 60 seconds between batches, or 5 seconds while pools need recovery. These are batch intervals, not a promise that every pool is checked once a minute. Selected pools are temporarily unavailable while their block-pinned snapshot is refreshed. Events arriving during the read are replayed afterward; the saved database snapshot stays at its completed block. If the bounded replay buffer overflows, the pool stays unavailable and retries from a newer snapshot.

The feed must deliver complete, ordered logs. There is no per-pool consecutive log counter, so skipped block numbers alone do not prove a gap. Disconnects trigger reconciliation, and rotating checkpoints repair events missed by the subscription when HTTP history is complete. A provider silently omitting events from both sources cannot be made reliable by a local cache.

Your RPC must serve historical factory logs and block-pinned contract reads. Recent historical state is enough for a fresh download, but an archive endpoint helps resume older downloads. A provider that silently truncates logs can produce an incomplete catalog; use one that returns complete results or an explicit range-limit error.

### Updating the query contract

An existing deployment cannot gain the new methods from a local file edit. Compile and deploy `FlashUniswapQueryV1` from [UniswapFlashQuery.sol](Contract/UniswapFlashQuery.sol), then put its address in `UNISWAP_FLASH_QUERY_CONTRACT_ADDRESS`. V3 uses `getV3PoolMetadata`, `getV3LiveStates`, `getV3TickBitmapWords`, and `getV3Ticks`. The old `getV3StartupStatesAroundCurrentTick` endpoint has been removed from the source and ABI. External callers of that endpoint must migrate to the full-range reads before using a new deployment. The V2 and Carbon read methods remain available. This change does not require redeploying `NArb`.

With Foundry installed, `forge build` compiles the contracts. Deployment is a separate, paid transaction; it is not performed by sync or startup. After deployment, run `bun run sync:markets`, then restart the bot. A deployment missing the V3 read methods will fail those calls. V2-only startup does not require them.

### Carbon

Edit `CARBON_CONTROLLERS` in [src/protocols/carbon/config.ts](src/protocols/carbon/config.ts). Each controller has an address and an `enabled` flag.

Carbon discovery uses tokens from `TOKENS` and the enabled V2/V3 markets. It reads each pair's trading fee from the controller.

Carbon discovery does not scan historical blocks. A Carbon-only sync reads each controller's current pair list and preserves stored V2 and V3 markets. Live strategy create, update, and delete events are handled separately while the bot runs.

After editing a market definition, sync that protocol and restart. Set a V3 factory or Carbon controller to `enabled: false` to exclude it. To disable V3 entirely, use the protocol switch in `src/constants.ts`; no factory edits are needed.

## Tokens, search, and execution

These settings are in [src/constants.ts](src/constants.ts):

- `TOKENS` lists the search start tokens, liquidity thresholds, and minimum profits. Amounts use `tokenAmount` with the token's decimals.
- `ARBITRAGE_SEARCH_POLICY` controls route length, search width, sizing iterations, and the number of opportunities returned.
- `maxSearchExpansions` caps route exploration at 50,000 edge attempts. `maxCandidatesToSize` selects up to 64 candidates by marginal exchange rate before exact sizing. Both live in `ARBITRAGE_SEARCH_POLICY`; lower limits save computation but can miss profitable routes.
- `EXECUTION_POLICY` controls transaction submission, the gas limit, and gas prices. The `gasPrice` helper takes values in gwei.
- `RUNTIME.websocketEnabled` controls whether startup uses the configured WebSocket endpoint.

Linear-route reported profit includes swap fees and deducts the selected flash-loan fee when a funding pool is available. Gas is not deducted from that legacy figure. Set token profit thresholds with that in mind.

### Split routing

`ARBITRAGE_SEARCH_POLICY.splitRouting` in [src/constants.ts](src/constants.ts) controls split-and-merge search across V2, V3 and Carbon. It is **off by default**. It uses the same `TOKENS`, `topTokens`, token `minProfit` and reserve-fraction cap as linear search; there is no second token list. Supported plans have at most two branches per stage, three stages and six swaps, in one atomic transaction. The search compares conservative net profit with the funded linear candidates and tracks every branch for stale-state rejection.

`shadow` searches without submitting split trades. It does **not** disable existing linear trading; set `EXECUTION_POLICY.executeTrades = false` for observation only. `live` needs a newly deployed NArb and fresh gas-cost data. `NETWORK.wrappedNativeToken` uses its native 1:1 conversion; other borrow tokens need a fresh `gasConversion` on their existing `TOKENS` entry, or rates supplied with the search request. No deployment happens automatically.

The new NArb implementation makes both execution entry points owner-only, validates callbacks and exact branch spending, and enforces a final profit floor for splits. Its ABI is generated with `bun run abi:arb` after `forge build`. See [split routing](docs/split-routing.md) for configuration, amount accounting, gas assumptions, rollout requirements and offline replay commands.

Execution sends a transaction through `ARB_CONTRACT_ADDRESS`. Submission logs and Telegram messages mean the transaction was sent; they don't confirm that it succeeded or earned the quoted profit.

### The live path

Market events update the main graph before scheduling a search. Search and sizing run in a Bun worker, warmed while startup is still buffering events. V2 reserve updates and V3 state/tick changes are coalesced into compact worker patches. Carbon sends a full strategy snapshot at startup or recovery, then sends only changed strategies and deletion IDs. Only one search runs at a time; queued requests retain the latest update per market. Liquidity deltas are applied before this queue, never discarded as superseded search work.

A Carbon update rebuilds the changed strategy's edges and the two trading directions for its pair, on both the main graph and the worker. Other pairs keep their edges and ranking caches. Strategies are keyed by controller and ID; native currency and its wrapped token remain separate execution groups. Repeated changes to a strategy are folded into its latest state before transfer. Groups still select at most eight orders, with strategy ID breaking equal-rate ties. Updating a busy pair still requires inspecting that pair's strategies, but no longer the whole Carbon catalog. A restarted worker receives a fresh full snapshot, including changes drained by a failed search.

Candidates carry revisions for their route pools and funding pool, plus the feed revision. Execution checks these after search, before signing, and again immediately before broadcasting. Carbon changes currently invalidate all Carbon candidates. `RUNTIME.candidateMaxAgeMs` also rejects candidates older than 500 ms from the triggering event receipt. A disconnected feed pauses acceptance until reconciliation finishes.

Transaction data, gas, fees, chain ID, and nonce are supplied locally. The account signs locally, then the wallet sends the signed bytes. There is no transaction-fill, gas-estimation, chain-ID, or nonce lookup on that normal submission path. If signing fails or the market changes before broadcast, only that known-unsubmitted nonce can be reused. Once a submission has been attempted, the conservative uncertain-nonce policy below still applies.

Opportunity/debug logs and Telegram notifications use bounded background queues. A slow Telegram request does not delay the next trade; requests time out after `RUNTIME.notificationTimeoutMs`. Queues can coalesce or drop diagnostics under load, so these messages are not a durable trade ledger. Checkpoint reads/writes run outside live event handling, but SQLite writes still share the main process and can briefly occupy its event loop.

Every `RUNTIME.metricsIntervalMs` (60 seconds), the bot prints bounded latency samples and counters. Timings cover dispatch, V3 application, worker transfer/application, search, signing, submission acknowledgment, and receipt observation. Percentiles use the latest 512 samples per stage; counts are cumulative. Receipt tracking polls in the background, at most eight requests per batch, and expires after two minutes. Receipt-observation time includes polling and RPC delay, not just chain inclusion time. A successful receipt does not establish realized profit.

The worker has a `RUNTIME.searchTimeoutMs` deadline. A failed or timed-out job produces no trades; the next scan rebuilds the worker from current state. Changing search limits or timeouts requires a restart. These limits bound work and reject stale results; they do not guarantee profitable execution or eliminate competition, RPC delay, or garbage-collection pauses.

When execution is enabled, startup fetches the wallet's pending nonce before enabling submissions. Each trade then reserves its nonce locally, without a nonce RPC read. `EXECUTION_POLICY.nonceRefreshIntervalMs` defaults to 12 hours; background checks can advance the counter but never move it backward. Failed refreshes retry after `nonceRetryIntervalMs`, which defaults to 5 seconds.

A failed or uncertain submission pauses new submissions and triggers an immediate nonce check, followed by the shorter retry interval. Trading resumes only after the RPC's pending nonce has advanced past every uncertain nonce. A rejected or dropped transaction can therefore require operator intervention. Inspect the wallet's pending transactions before restarting; the bot does not reuse uncertain nonces, send cancellation transactions, or replay stale arbitrage trades automatically.

Use a dedicated wallet with one bot process. This in-memory allocator does not coordinate independent processes or other applications using the wallet. The periodic check is not a distributed wallet lock. Watch-only mode does not fetch nonces or start a refresh timer.

## What sync keeps

The SQLite database stores the filtered trading list in a chain-bound file. V2 has separate, chain-scoped tables for its complete discovered catalog and pair-count checkpoints. V3 has separate tables for its complete discovered catalog, factory checkpoints, completed snapshots, and unfinished downloads. Replacing the trading list or disabling a protocol does not erase these tables. Tables are created automatically in the new file. Legacy catalogs without a chain identity require a fresh path and sync as described in [switching networks](#switching-networks); no existing database is deleted.

V2 reserves and Carbon orders are fetched when the bot starts and updated in memory. V3 state is also checkpointed to SQLite so a restart can catch up rather than download every tick again.

The trading list excludes addresses in [src/bannedtax.json](src/bannedtax.json). It also removes markets unless both tokens appear in more than one discovered market. These filters do not delete V3's complete discovery catalog. V2 and Carbon apply additional liquidity filters when loading live state, so a discovered market may still be excluded from the graph.

Startup buffers market events while loading state, reconciles those events, then starts searching. New V2 and V3 pools are discovered, saved, hydrated, and subscribed while the bot remains online. Configuration changes still require a restart; run the relevant sync first when changing factory definitions or `fromBlock`.

## When something doesn't show up

If startup reports `No markets for enabled protocols`, run sync with the protocol list you intend to use. Check that sync and startup point to the same `MARKET_DB_PATH`.

For a missing pool, check its factory or controller, the enabled protocols, and the filters described above. For V3, also check `fromBlock`, the deployed query contract's methods, and whether the RPC can read the required history. `V3 snapshot unavailable` means the pool was excluded, not loaded with a partial range. Set `DEBUG=true` in `.env` for loading details.

If opportunities appear but no transaction is sent, check `executeTrades` and the arbitrage contract address. A route also needs a separate pool that can lend the starting token. Finding a profitable swap route alone isn't enough to execute it.

## Working on the code

```sh
bunx tsc --noEmit
bun test
forge test
```

The Bun tests use fixtures and mocked clients. Foundry tests run the query and arbitrage contracts against local mock pools. Neither submits trades or requires a live chain. The Bun suite includes the stress tests. You can also run the V2 stress tests and the local benchmarks separately:

```sh
bun run test:stress
bun run bench:stress
bun run bench:carbon
bun run bench:split
```

The V2 stress tests accept `V2_STRESS_PAIRS`, `V2_STRESS_SEARCH_LIMIT_MS`, and `V2_STRESS_UPDATES` environment overrides. The benchmark also runs repeated worker searches while sampling a main-thread heartbeat. Cold graph transfer is included in transfer metrics; subsequent live transfers contain only changed markets. Compare repeated runs on the same machine. Synthetic timings are not live-network latency measurements.

The Carbon benchmark compares full-snapshot updates with single-strategy patches across 10,000 synthetic strategies in 1,000 pairs. It reports main-graph update, patch extraction, structured-clone, and worker-graph application timings over 60 warmed samples. JSON bytes are a payload-size proxy; clone timings are not worker round-trip measurements. The tests separately exercise a real Bun worker and compare incremental quotes and execution data with full rebuilds.

For a new protocol, start with [ProtocolPlugin](src/protocols/protocol-plugin.ts). Implement discovery, state loading, events, quotes, and execution encoding, then add the required catalog and graph support. Register the plugin in [src/protocols/registry.ts](src/protocols/registry.ts) and add its ID to `allowedProtocols`. Keep the TypeScript contract ID, Solidity execution support, and deployed ABI in agreement.

See [switching networks](#switching-networks) before changing chains. The provided addresses are a Sei configuration, not a cross-chain address registry.

## License

[MIT](LICENSE).
