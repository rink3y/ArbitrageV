# Split routing

Split routing is controlled by `ARBITRAGE_SEARCH_POLICY.splitRouting`. It searches short circular trades with up to two pools per stage, three stages and six swaps. V2, V3 and Carbon can participate, subject to `ARBITRAGE_SEARCH_POLICY.allowedProtocols` and `allowProtocolMixing`.

```
                            100 A -> pool 1 -> 181 B
Borrow 200 A -> split ----<                          >---- merge 362 B
                            100 A -> pool 2 -> 181 B             |
                                                               v
                                                      pool 3 -> 306 A
                                                               |
                                                     repay + keep surplus
```

Those numbers are a zero-fee local test fixture, not a market opportunity. A stage has one input token and one output token. Different intermediate tokens in parallel branches, arbitrary routing graphs and cross-chain execution are not supported.

## Controls

Use the existing settings in `src/constants.ts`. There is no separate split token list.

| Setting | Effect on splits |
| --- | --- |
| `ARBITRAGE_SEARCH_POLICY.splitRouting` | `off` skips splits; `live` searches them alongside linear routes. Submission requires `executeTrades: true`. |
| `ARBITRAGE_SEARCH_POLICY.splitSearchMs` | Extra worker time allowed for split search. Default: 10 ms, checked cooperatively. |
| `TOKENS` and `topTokens` | The same first N tokens are eligible to start linear and split trades. Intermediate tokens can still come from the graph. |
| Token `minProfit` | Linear routes must exceed it after the conservative gas allowance. Splits must exceed it before gas and remain positive after gas. |
| `maxInputReserveFraction` | Caps each opening branch at its input capacity divided by this value. Combined borrowing cannot exceed those caps added together. |
| `maxRouteEdges`, `allowedProtocols`, `allowProtocolMixing` | Existing route restrictions also apply to splits. The contract permits at most three split stages. |
| `maxCandidatesToSize`, `maxSearchExpansions` | Reused as the split topology and work limits. Each search phase has its own counter; these are not a combined per-job budget. |
| `beamWidth` | Limits the split alternatives shortlist, with an internal maximum of four. |
| `EXECUTION_POLICY.gasLimit` and fee settings | One periodically refreshed fee snapshot prices search and submission. |
| `EXECUTION_POLICY.slippageBps` | Haircut on each split branch output. Default: 5 basis points. |

`liquidityAmount` still filters which markets load; it is not a borrowing limit. For V3, the opening cap uses virtual input reserves; for Carbon, it uses order input capacity. Later stages spend only the preceding stage's minimum proceeds.

Two branches per stage and six swaps are contract limits, not tuning knobs. The allocator uses eight coarse samples and three refinement rounds internally. Linear sizing still uses `optimizationIterations`. Split deadlines expire 30 seconds after observation; the existing, shorter candidate-age check also applies.

Restart after changing settings. To observe without sending **any** transactions, also set `EXECUTION_POLICY.executeTrades = false`. With `splitRouting: 'live'` and execution disabled, both searches still run.

## What the search does

The existing linear search runs first. Token cycles are captured before its minimum-profit filter, so a rejected single route can still seed a split. For each eligible cycle, the graph supplies a bounded mix of high-rate and high-capacity alternatives. The search tries disjoint branch subsets, samples borrow sizes and allocations, then refines around promising samples. It requotes complete plans before accepting them.

All amount calculations use integers. Quotes run on the worker's local graph, with no RPC requests. Funding-pool scans and V3 tick traversal consume the split work budget. Carbon's existing eight-order grouping and bounded allocation algorithm remain in use.

This is a heuristic, not a global optimizer. It can miss routes because of the cycle beam, pool shortlist, topology cap, sampling, Carbon grouping or deadline. It does not exhaustively evaluate every split. A budget stop means incomplete exploration, not proof that no profitable trade exists. One winning split per borrow token is returned alongside the linear results.

The wall-time checks are cooperative. A JavaScript operation, cold tick-cache sort, garbage collection or worker scheduling can run beyond a check's deadline. The worker cannot observe a queued market update while synchronous search is running. Main-thread revision checks still reject stale results after it returns. Split search also delays the return of that job's linear results by its runtime; it is not free latency.

## Profit and cost

```
conservative net = minimum final proceeds
                 - borrowed principal
                 - flash fee
                 - gas allowance in the borrow token
```

Swap fees and price impact are already reflected in the quotes. Favorable intermediate leftovers are assigned no value in the score. The split must exceed the token's existing `minProfit` before gas, remain positive after gas, and beat the best sized, funded linear candidate for that token under the same gas model. Linear candidates below the old reporting threshold still count in this comparison.

The initial gas model charges the **full transaction gas limit at the configured fee cap**, not an optimistic per-swap estimate. That covers a successful transaction within that limit, including callbacks, approval resets, wrapping and calldata execution costs. It may reject profitable trades and does not prove a route fits the limit. It also does not accurately rank the difference in actual gas between a short linear trade and a longer split. Protocol-specific calibrated gas estimates are not implemented. Gas-limit feasibility and actual gas use still need fork simulation before rollout.

`NETWORK.wrappedNativeToken` uses the native-token identity conversion. Other tokens can supply `gasConversion: { numerator, denominator, validUntil }` on their existing `TOKENS` entry. This is a conservative `numerator / denominator` in smallest token units per smallest native unit and a `validUntil` Unix-millisecond timestamp. Missing, invalid or expired conversions make that borrow token ineligible for both linear and split live searches. Gas fee refreshes do not refresh these token conversion rates. An upstream cached price source can instead supply `FindOpportunitiesRequest.splitCosts`. Never derive gas prices from token minimum-profit settings. Additional chain-specific fees such as rollup L1 data fees are not included in the execution-gas model; live execution requires those costs to be accounted for before rollout.

The executor checks that a split's priced gas cap equals the cap it will sign. A refreshed fee snapshot, expired costs, expired deadlines, changed market revisions and old candidates are rejected before submission. These checks run again after signing. There is still a gap between broadcast and inclusion.

## Contract execution

`executeSplitArbitrage` receives exact input amounts and minimum outputs for every branch. Branches return proceeds to NArb; they do not use the linear path's direct V2-to-V2 forwarding.

The contract checks stage continuity, the circular end token, branch/stage limits, funding-pool exclusion, duplicate pools and duplicate Carbon strategy IDs. A grouped Carbon action and a single action cannot spend the same strategy. Carbon amounts are not resized to consume whatever happens to be in the wallet.

Each stage can spend only the loan or the preceding stage's proceeds. Each branch must consume exactly its assigned input. Input/output balance deltas enforce this; a pre-existing balance cannot cover an underfunded stage. Favorable leftovers stay in NArb. The final borrowed-token balance must preserve its pre-loan balance plus `minSurplusAfterRepayment` after repayment. That floor is `max(token.minProfit, gasAllowance) + 1` in smallest token units, enforcing both the shared threshold and positive net profit. It is a token balance check, not reimbursement of the sender's measured gas bill. A reverted transaction still costs gas.

Both transaction entry points are now **owner-only** and reject reentrancy. Flash callbacks must return the exact pending payload, once. V3 callbacks must request the expected input token and exact input amount; partial input fills are rejected. Carbon receives an exact-amount approval, with any remainder cleared after the trade. Native-currency branches unwrap/wrap only their assigned amounts and outputs through the immutable wrapper supplied to `ArbitrageExecutor(owner, wrappedNativeToken)`. It must match `NETWORK.wrappedNativeToken`; updating an existing deployment requires redeployment.

These changes require a **new NArb deployment** to use splits. The old linear function signature remains, but its new implementation has tighter authorization and callback checks. The signing wallet must be the new contract's owner. No deployment or live transaction is part of this implementation. UniswapFlashQuery is unchanged; there is no version handshake.

Pool/controller addresses come from the configured market graph and owner-signed plan. This is not an on-chain factory allowlist. Only supported, trusted deployments and ordinary non-taxed, non-rebasing tokens should be admitted. A local mock suite is not an independent contract audit.

The main process locks every branch pool before submission. Carbon controller-level locks are conservative and can also block disjoint strategies on that controller. Funding is a revision dependency, not an exclusive lending lock. A split uses one transaction and one local nonce. When split routing is off, split candidates are rejected at the submission boundary even if passed there directly.

## Offline checks

```sh
bunx tsc --noEmit
bun test
forge test
forge build --sizes
bun run abi:arb
bun run bench:split
```

Foundry uses Solidity 0.8.27, optimization and `via_ir` for the nested stage ABI. `abi:arb` copies the compiled NArb ABI; there is no handwritten duplicate function ABI.

The test suite includes an independent exhaustive small-integer V2 allocation oracle, exact-input and cost checks, worker mirroring, stale funding/branch revisions, off-mode submission guards, ABI signing through an in-memory transport, and Solidity tests for V2/V3/Carbon, native wrapping, callback validation, old-balance isolation and a fuzzed final-profit floor. The V3 contract mock checks execution/callback behavior; it is not a substitute for running against deployed pool bytecode.

`bench:split` compares warmed worker round trips with split search off and on using four synthetic V2 pools. It also performs a separate stateful V2 depletion experiment: each hypothetical fill changes reserves before the next search. It never treats repeated unchanged quotes as independent earned revenue. Its fill model does not simulate V3 or Carbon trades.

Synthetic timings are not live-network latency or profit evidence. Rerun the benchmark and representative recordings before choosing a production time budget.

For recorded graph data:

```sh
bun run replay:split recording.ndjson
```

`recording.ndjson` is a placeholder, not a bundled file. Supply a real recording, or use `bun run bench:split` for the synthetic example. Replay enables split search and uses the existing `TOKENS`/`topTokens` selection; frame start tokens can narrow that selection, not expand it. No second token setup is needed.

Each line is a frame `{ at, changes, startTokens, costs }`. `at` is the capture timestamp in Unix milliseconds; `changes` is a full initial `GraphChanges` snapshot, followed by ordered deltas; `costs` is the contemporaneous `SplitCosts` snapshot. Use `replayJSON.stringify` from `src/opportunities/split-replay.ts` to encode bigints as `{ "$bigint": "123" }`. Keep signing keys and RPC credentials out of recordings. The tool constructs no network client, signer or executor, regardless of `executeTrades`.

Cost expiry is rebased relative to each recorded timestamp, preserving whether it was fresh at capture. Output includes linear and split quotes, work/deadline statistics, timings and repeated consecutive quote counts. This is observation replay, **not a historical P&L backtest**: recorded chain states do not include our hypothetical fills. No revenue total is produced. A representative Sei recording, actual gas calibration, fork validation, competition/inclusion analysis and independent contract review remain rollout work, not evidence established by these offline tests.
