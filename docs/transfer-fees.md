# V2 transfer-fee support

This implementation estimates inclusive transfer deductions for specific pool/executor combinations. It does not certify tokens as safe or infer one permanent tax rate per token.

## Before enabling it

Keep `EXECUTION_POLICY.executeTrades` false during deployment and validation. Deploy the updated `ArbitrageExecutor` and `FlashUniswapQueryV1`, then update both addresses in `.env`. The linear execution ABI now includes `minSurplusAfterRepayment`, so the new bot must not submit to the old NArb deployment, even with profiling disabled. `bun run abi:arb` regenerates both shared ABIs from `forge build` artifacts.

Set `V2_LIVE_POLICY.transferFees` to `true` in `src/protocols/v2/config.ts`. It defaults to false to avoid calling new methods on existing deployments. Keep `ARBITRAGE_SEARCH_POLICY.allowedProtocols` set to `['v2']`. Then run `bun run sync:markets --protocol v2` and start with execution still disabled. Explicit entries in `src/bannedtax.json` remain banned.

## What the probe measures

FlashQuery batches calls to NArb. NArb flash-borrows a sample from a V2 pool, measures the pool's debit and its own credit, sends half the received tokens to its owner, and sends the remainder back to the pool. It records requested, debited and credited amounts for all three transfers. The callback deliberately reverts with the observations. Each probe therefore restores balances and pool state before the next probe runs.

These are unsigned `eth_call` simulations. They do not spend wallet gas or send transactions. They require an RPC that allows non-view simulation and the requested call gas. NArb itself performs transfers, so the token sees the executor address rather than the FlashQuery address. The simulated transaction origin and external-transfer recipient are NArb's owner.

The measured contexts are:

| Label | Sender | Recipient |
| --- | --- | --- |
| Buy | This pool | NArb |
| Sell | NArb | This pool |
| Transfer | NArb | NArb's owner |

The external-transfer result is informational. It says nothing about another recipient. The sell probe measures a transfer back, not a completed sell swap. Flash-borrow and ordinary swap conditions can differ, and a token can change behavior based on state, amount, gas, caller, or time. Matching samples are evidence for an estimate, not proof of compatibility. Full-route simulation on a fork is still needed before trusting a new token with live gas expenditure.

## Quotes and execution

With profiling enabled, both linear and split V2 routes use executor custody between hops. Each edge applies the measured NArb-to-pool deduction, calculates the AMM output with the pool fee, then applies the pool-to-NArb deduction. For example, an input of 100 with a 10% sell deduction gives the AMM 90. If the AMM quotes 200 output and that pool's buy deduction is 22%, NArb receives an estimated 156.

Pool A and pool B keep separate observations for the same token. A direct pool-to-pool transfer is not measured by these probes and is not quoted by combining buy and sell percentages. Custody routes use two real transfers instead. This costs more on-chain gas than forwarding directly. With profiling disabled, normal V2 routes retain their existing forwarding path and untaxed quote assumptions.

On-chain V2 execution uses `balanceOf(pool) - reserveIn` for effective input and recipient balance changes for output. Extra sender debits are rejected. Both execution paths protect existing borrowed-token inventory and require actual final proceeds to cover repayment and the specified surplus. Linear plans require the quoted surplus less `EXECUTION_POLICY.slippageBps`, rounded up; split plans retain their existing stage minimums and surplus floor. A failed transaction still costs gas.

The borrowed asset must have observed zero buy and sell deductions on its funding pool, with borrowing and repayment inside the observed ranges. V3 and Carbon are deliberately excluded from this mode. Rebases, trailing fees, inconsistent deductions and failed probes are not supported as ordinary percentage fees.

## Cache and refresh

Profiles live in `v2_transfer_profiles` in the existing chain-bound SQLite database. Keys include executor, origin, pool and token. Records include the block number and hash, observation time, expiry, raw measurements, failure selectors, estimated deductions and measured amount bounds. Unknown is distinct from an observed zero deduction. A profiling pass checks its block hash again before saving observations. Cached observations also have their block hashes checked when loaded.

The default probes request four sizes, from one hundred-millionth to one quarter of a reserve. Sell and external-transfer bounds come from the actual amounts tested, not the requested borrow sizes. A model needs at least two distinct sizes, exact sender debits, positive credits and rates agreeing within one basis point. Quotes use the largest observed rounded-up deduction and never extrapolate outside the tested minimum and maximum. This bounded interpolation still cannot rule out an untested threshold between samples.

Sync and startup fill missing or expired profiles. Calls are batched in groups of up to eight probes with four batches in flight. The first run can be expensive for a large catalog; subsequent runs reuse current profiles. All batches use one block per profiling pass.

Profiles expire after `transferRefreshMs`, one hour by default. The live adapter checks locally once a minute and starts background calls only for missing or expired observations. Expired profiles stay ineligible until refreshed. A provider failure does not turn an unknown profile into zero tax. Successful refreshes publish pool revisions to invalidate earlier quotes, while expiration is also checked locally before submission. New pool profiles are picked up by the same background pass.

Search, signing and submission perform no probe RPCs. Refresh merges only the new profile into the latest pool state, preserving reserves updated by events during the simulation.

Worker snapshots carry estimates without raw probe samples. Later reserve deltas omit unchanged profiles; a profile refresh sends the new estimates once. Raw observations remain in SQLite. The existing historical replay CLI does not rebase transfer-profile expiry to recorded time, so expired tax profiles are rejected there rather than assumed current.
