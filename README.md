# ArbitrageV

An event-driven arbitrage bot, written in TypeScript and run with Bun current set on Sei EVM chain.

It discovers and tracks V2 pools, configured V3 pools, and Carbon strategies, keeps their live state in an in-memory graph, searches mixed-protocol routes, accounts for swap and flash-loan fees, and submits profitable routes through the arbitrage contract.

This is trading code, not a toaster. It can sign real transactions and lose real money. Read the config before giving it a funded key.

## How it works

```text
protocol config -> market sync -> SQLite catalog
                                  |
                                  v
events -> startup buffer -> live-state hydration -> market graph
                                                    |
                                                    v
                                     search -> size -> execute
```

Startup subscribes to market events **before** fetching live state. Events received during hydration are buffered and reconciled before the first search, so the graph does not begin life one block behind.

Each protocol is a plugin under `src/protocols/<protocol>/` with the same public layout:

```text
config  events  execution  metadata  quote  runtime  types  index
```

Shared code owns graph search, scheduling, persistence, and transaction submission. Protocol plugins own their discovery, state, event decoding, quotes, fees, and calldata details.

## Adding a protocol

Start by copying the public shape, not another protocol's internals:

```text
src/protocols/my-protocol/
  config.ts       addresses and tuning knobs
  events.ts       ABIs and event decoding
  execution.ts    fees and execution encoding
  metadata.ts     market discovery/catalog data
  quote.ts        protocol-specific swap math
  runtime.ts      hydration and live event adapter
  types.ts        protocol-owned data types
  index.ts        the ProtocolPlugin implementation
```

Then wire the boring bits:

1. Implement `ProtocolPlugin` from `src/protocols/protocol-plugin.ts`. Give it an `id`, unique `contractId`, `discover`, `hydrate`, `events`, and `count`.
2. Add any new catalog/graph types to the shared market model. Reuse existing shapes when they are genuinely compatible; fake compatibility gets expensive fast.
3. Register the plugin in `src/protocols/registry.ts` and include its ID in `ARBITRAGE_SEARCH_POLICY.allowedProtocols` in `src/constants.ts`. Order matters when one plugin's discovery depends on another, like Carbon using the V2/V3 token universe.
4. Add matching route execution support in `Contract/NArb.sol`. The TypeScript `contractId` and Solidity protocol ID must agree or the bot will confidently encode nonsense.
5. Run `bun run sync:markets`, then typecheck and test. A plugin is done when discovery, startup hydration, event updates, quotes, and execution all describe the same market.

The shared runtime already handles startup buffering, scheduling, and reconnects. A plugin should provide protocol facts, not build its own mini bot.

## Setup

Requires [Bun](https://bun.sh/) and a RPC endpoint.

```bash
bun install
cp .env.example .env
```

Fill in `.env`, then review:

- `src/constants.ts` for tokens, search limits, profit thresholds, gas, and execution policy.
- `src/protocols/*/config.ts` for factories, pools, controllers, fees, and batching.
- `src/network` to change network

`EXECUTION_POLICY.executeTrades` is currently `true`. That is intentionally loud here.

To enable or disable protocols, edit only `ARBITRAGE_SEARCH_POLICY.allowedProtocols` in `src/constants.ts`:

```ts
allowedProtocols: ['v2'], // V2 only. Add 'v3' or 'carbon' to enable them.
```

This list controls market discovery, live-state loading, event monitoring, and arbitrage routes. At least one protocol must be enabled. The registry preserves discovery order automatically.

Restart the bot after changing the list. Disabling a protocol takes effect even if its markets remain in SQLite. When enabling a protocol, run `bun run sync:markets` first to populate its markets. Sync replaces the catalog with markets from the enabled protocols only.

## Run

Build the local market catalog first:

```bash
bun run sync:markets
```

This writes V2 pool metadata, V3 pool metadata, and Carbon pair metadata to `data/markets.sqlite`. Re-run it after changing protocol or token configuration.

Start the bot:

```bash
bun start
```

The bot loads SQLite, starts the event feed in buffering mode, hydrates current protocol state, reconciles startup events, runs the initial search, and then scans again whenever tracked state changes.

## Checks

```bash
bunx tsc --noEmit
bun test
bun run test:stress
bun run bench:stress
```

The stress test accepts `V2_STRESS_PAIRS`, `V2_STRESS_SEARCH_LIMIT_MS`, and `V2_STRESS_UPDATES` overrides.

## Project map

```text
src/protocols/       protocol plugins: V2, V3, Carbon
src/market-graph/    graph topology and quote traversal
src/opportunities/   search, sizing, ranking, and workflow
src/runtime/         bot lifecycle, event transport, scheduling
src/execution/       route planning and contract call construction
src/market-db.ts     SQLite market catalog
Contract/            on-chain arbitrage contract
test/                unit and stress tests
```

Private keys belong in `.env`, which is ignored by Git. `.env.example` contains placeholders only. Do not get creative with that rule.
