# ArbitrageV

An arbitrage bot for Sei EVM, written in TypeScript and run with Bun. It looks for circular trades across V2 pools, V3 pools, and Carbon strategies, and can execute them using a flash loan from a V2 or V3 pool.

V2 pools are discovered from factories. V3 pools are listed manually. Carbon pairs come from the configured controllers. You choose which protocols to use in `src/constants.ts`.

## Getting started

You'll need Bun, a Sei HTTP RPC endpoint, and a deployed query contract matching [UniswapFlashQuery.sol](Contract/UniswapFlashQuery.sol). To submit trades, you'll also need a deployed [arbitrage contract](Contract/NArb.sol) and a wallet with SEI for gas. Contract deployment isn't included in the setup commands.

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

Sync builds the market list in `data/markets.sqlite`. Startup loads that list, fetches current market state, and begins watching for changes. Stop the bot with `Ctrl+C`.

### The .env file

| Variable | What it does |
| --- | --- |
| `RPC_URL` | HTTP RPC endpoint, required for both sync and startup. |
| `PRIVATE_KEY` | Wallet private key, required for startup even when trading is disabled. |
| `WSS_URL` | Optional WebSocket endpoint. Leave it unset to receive market events through HTTP. |
| `UNISWAP_FLASH_QUERY_CONTRACT_ADDRESS` | Deployed query contract used for market discovery and batch reads. |
| `ARB_CONTRACT_ADDRESS` | Deployed contract used to execute trades. |
| `MARKET_DB_PATH` | Overrides the default database path, `data/markets.sqlite`. |
| `DEBUG` | Set to `true` to see detailed market, opportunity, and transaction logs. |
| `TELEGRAM_BOT_TOKEN` | Bot token for transaction notifications. |
| `TELEGRAM_CHAT_ID` | Chat receiving those notifications. Leave both Telegram fields blank to disable them. |

## Switching protocols

Change `ARBITRAGE_SEARCH_POLICY.allowedProtocols` in [src/constants.ts](src/constants.ts). For V2 only:

```ts
allowedProtocols: ['v2'],
```

Add `'v3'` or `'carbon'` to enable them. All three are enabled by default. Keep at least one in the list.

This setting controls discovery, startup reads, event subscriptions, and route searches. Removing a protocol takes effect on restart, even if its old market entries are still in SQLite. No registry edits are needed.

When adding a protocol back, run `bun run sync:markets` before restarting. Sync replaces the database's market list with the enabled protocols' markets.

`allowProtocolMixing: false` restricts each swap route to one protocol. It doesn't disable any protocol, and the flash loan can still come from another enabled protocol.

Carbon can be part of a swap route but cannot provide the flash loan. The execution planner needs a V2 or V3 funding pool outside the route, so enabling only Carbon won't produce executable trades.

## Factories, pools, and controllers

### V2

Edit `V2_FACTORIES` in [src/protocols/v2/config.ts](src/protocols/v2/config.ts). Each entry needs a name, factory address, fee, and kind. The supported kinds are `uniswap-v2` and `solidly`.

The fee uses basis points: `30` means 0.30%. For Solidly pools, discovery reads the stable and volatile fees from the factory.

### V3

Edit `V3_POOLS` in [src/protocols/v3/config.ts](src/protocols/v3/config.ts). Each entry needs the pool address, `token0`, `token1`, `fee`, `tickSpacing`, and `enabled` flag. There is no V3 factory discovery yet, so each pool must be added here.

V3 fees use parts per million: `3000` means 0.30%. Set an entry to `enabled: false` to leave it out of the next sync.

### Carbon

Edit `CARBON_CONTROLLERS` in [src/protocols/carbon/config.ts](src/protocols/carbon/config.ts). Each controller has an address and an `enabled` flag.

Carbon discovery uses tokens from `TOKENS` and the enabled V2/V3 markets. It reads each pair's trading fee from the controller. Changing the config's `feePpm` field does not override that fee.

After editing any of these market definitions, run `bun run sync:markets` and restart. This also applies when disabling an individual V3 pool or Carbon controller, since their old entries can remain in the database until the next sync.

## Tokens, search, and execution

These settings are in [src/constants.ts](src/constants.ts):

- `TOKENS` lists the search start tokens, liquidity thresholds, and minimum profits. Amounts use `tokenAmount` with the token's decimals.
- `ARBITRAGE_SEARCH_POLICY` controls route length, search width, sizing iterations, and the number of opportunities returned.
- `EXECUTION_POLICY` controls transaction submission, the gas limit, and gas prices. The `gasPrice` helper takes values in gwei.
- `RUNTIME.websocketEnabled` controls whether startup uses the configured WebSocket endpoint.

Reported profit includes swap fees and deducts the selected flash-loan fee when a funding pool is available. Gas is not deducted from that figure. Set token profit thresholds with that in mind.

Execution sends a transaction through `ARB_CONTRACT_ADDRESS`. Submission logs and Telegram messages mean the transaction was sent; they don't confirm that it succeeded or earned the quoted profit.

## What sync keeps

The SQLite database stores market definitions. Live reserves, ticks, and orders are fetched when the bot starts and then updated in memory.

Sync excludes addresses in [src/bannedtax.json](src/bannedtax.json). It also removes markets unless both tokens appear in more than one discovered market. V2 and Carbon apply additional liquidity filters when loading live state, so a discovered market may still be excluded from the graph.

New pools and changes to token or market configuration need another sync and restart. Startup buffers market events while loading state, reconciles those events, then starts searching. Later searches run when tracked markets change.

## When something doesn't show up

If startup reports `No markets for enabled protocols`, run sync with the protocol list you intend to use. Check that sync and startup point to the same `MARKET_DB_PATH`.

For a missing pool, check its config entry, the enabled protocols, and the filters described above. Set `DEBUG=true` in `.env` for loading details.

If opportunities appear but no transaction is sent, check `executeTrades` and the arbitrage contract address. A route also needs a separate pool that can lend the starting token. Finding a profitable swap route alone isn't enough to execute it.

## Working on the code

```sh
bunx tsc --noEmit
bun test
```

Tests use fixtures and mocked clients; they don't submit trades or require a live chain. The full suite includes the stress tests. You can also run the V2 stress tests and the local benchmark separately:

```sh
bun run test:stress
bun run bench:stress
```

The V2 stress tests accept `V2_STRESS_PAIRS`, `V2_STRESS_SEARCH_LIMIT_MS`, and `V2_STRESS_UPDATES` environment overrides.

For a new protocol, start with [ProtocolPlugin](src/protocols/protocol-plugin.ts). Implement discovery, state loading, events, quotes, and execution encoding, then add the required catalog and graph support. Register the plugin in [src/protocols/registry.ts](src/protocols/registry.ts) and add its ID to `allowedProtocols`. Keep the TypeScript contract ID, Solidity execution support, and deployed ABI in agreement.

The current chain ID is `1329`. Moving to another chain requires more than changing that number: [src/network.ts](src/network.ts) and [src/sync-markets.ts](src/sync-markets.ts) use Sei's chain definition, and [src/tokens.ts](src/tokens.ts) and [NArb.sol](Contract/NArb.sol) contain Sei-specific native-token addresses. Factory, pool, controller, token, and deployed contract addresses also need to match the new chain.

## License

[MIT](LICENSE).
