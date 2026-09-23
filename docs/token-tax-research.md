# Measuring token transfer fees before trading

Research date: 2026-09-23. This note proposes changes; it does not implement tax support or establish that either failed route is profitable.

## What can be measured

The useful result is a transfer profile for a particular context, amount, and block. A universal `taxPercent` field would overstate what a probe establishes. ERC-20 defines transfers, balances, allowances, and related metadata, but no standard interface for buy tax, sell tax, exemptions, limits, or future fee changes. Calling an optional token-specific tax getter can supplement a simulation, not replace it. [ERC-20 specification](https://eips.ethereum.org/EIPS/eip-20)

For each attempted transfer, record the requested amount, sender balance decrease, recipient balance increase, and any revert. Recipient loss relative to the requested amount measures an inclusive transfer deduction. A larger sender debit identifies a different behaviour and should not be treated as that same percentage. Measure balances, not just `Transfer` event amounts.

The two supplied traces establish different observations. The first showed a drastic shortfall when `0x7cd551498D2C29238DcCB51d29Ae35FAac0c3de7` moved between pools. The second showed a 22% deduction for one transfer of `0x8d328B39c6B26b721777f007e8212100CeB51335`. Neither observation proves a permanent rate for every amount or recipient.

## A relevant existing implementation

Uniswap already publishes a [FeeOnTransferDetector](https://github.com/Uniswap/util-contracts/blob/main/src/FeeOnTransferDetector.sol). It flash-borrows the token from a V2 pair, compares the requested amount with the detector's balance increase, tests an external transfer, and measures a transfer back to the pair. Its callback deliberately reverts with encoded measurements. The caller catches those bytes and exposes single-token and batch results. This avoids funding the detector with tokens or completing flash repayment during the measurement.

Its `sellReverted` flag means the transfer back failed. A successful transfer back is not proof that a complete sell swap succeeds. The callback is specifically `uniswapV2Call`. Its imported [pair-address library](https://github.com/Uniswap/util-contracts/blob/main/src/lib/UniswapV2Library.sol) also hardcodes Uniswap's pair initialization hash. Our multi-factory implementation would need known pool addresses and validated callbacks for each supported factory, rather than assuming this detector can run unchanged on Cronos.

## How simulation fits FlashQuery

The current [FlashQuery](../Contract/UniswapFlashQuery.sol) batches view reads. A transfer probe requires a separate non-view entry point, even when the application calls it through JSON-RPC `eth_call`. `eth_call` can execute writes in temporary state and discard them afterward. EVM `STATICCALL` instead rejects state-changing operations, including ordinary token transfers. [Geth call documentation](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth), [Ethereum Foundation explanation of discarded writes](https://blog.ethereum.org/2020/07/17/ask-about-geth-snapshot-acceleration), [STATICCALL specification](https://eips.ethereum.org/EIPS/eip-214)

An implementation can expose batched probes alongside the existing query methods. Each item should execute inside its own reverting subcall. The outer call catches a tagged result or failure and proceeds to the next item. Reverting restores the subcall's state and carries result bytes, so earlier probes do not consume balances or change reserves for later probes. A plain loop of successful simulated swaps would share temporary state within that one call. [REVERT specification](https://eips.ethereum.org/EIPS/eip-140)

Use bounded batch sizes, per-probe gas limits, and a result status for failures. Missing liquidity, unsupported callbacks, exhausted gas, and unexpected return data must remain distinguishable from an observed zero deduction. This is a design recommendation, not behaviour supplied by the current query contract.

Flash borrowing makes a basic probe possible without owned inventory. More complete route probes need a viable funding source and must respect the lending pool's reentrancy lock. They cannot simply perform another swap on the still-locked flash lender. Run these as simulation calls, not signed transactions.

## Match the actual transfer path

The local [NArb executor](../Contract/NArb.sol) forwards consecutive direct V2 swaps from one pool to the next. Split branches return output to NArb, then transfer input from NArb to another pool. Those are different transfer contexts. Applying independent buy and sell deductions to one pool-to-pool transfer can charge tax twice; applying a measured pool-to-helper rate to it can be wrong in the other direction.

The profile therefore needs to identify the tested sender, recipient, pool, call path, amount range, and block. Solidity contracts can inspect caller, transaction origin, block state, and stored configuration, which makes context-dependent behaviour possible. Changing the outer `eth_call` sender does not change an inner helper contract into NArb. [Solidity execution-context documentation](https://docs.soliditylang.org/en/latest/units-and-global-variables.html)

Several probe sizes can expose amount dependence or transfer limits, but do not prove behaviour at every size. A helper-based profile should be marked as such. A future executor-compatible simulation path or local fork can test the actual route identity more closely. Neither guarantees that the same conditions will hold when a later transaction executes. Uniswap's own [token validator interface](https://github.com/Uniswap/swap-router-contracts/blob/main/contracts/interfaces/ITokenValidator.sol) explicitly treats a probe without detected problems as unknown, not proof of compatibility.

## Required quote and execution changes

Detection alone cannot fix the failures. The current [V2 quote](../src/protocols/v2/quote.ts) calculates output from nominal input. NArb's `_swapV2` also quotes nominal input before transferring it. Both must use amounts that account for supported transfer behaviour.

Uniswap's [Router02 implementation](https://github.com/Uniswap/v2-periphery/blob/master/contracts/UniswapV2Router02.sol) supplies the relevant execution pattern. Its fee-supporting swaps derive a hop's effective input from the pool's token balance minus the recorded input reserve, calculate output from that value, and enforce the final minimum using the recipient's balance change. Adapting this pattern allows ordinary inclusive transfer fees to affect execution correctly. It adds contract balance reads but no external RPC round trip to the bot's trade loop.

Off-chain quotes still need cached transfer estimates to choose profitable amounts. Tax should apply to each actual transfer, alongside pool fees, flash repayment, and gas. Final repayment and minimum profit must depend on measured balances. Initially keeping the borrowed and repaid asset free of transfer deductions avoids another unsupported repayment case.

This also changes how routes are evaluated. A quote interface that sees only one edge and an amount cannot choose a pool-to-pool transfer profile without knowing the adjacent pool or recipient. Route selection, marginal prices, and amount sizing must share that context. Restrict eligible routes to measured contexts and amount ranges instead of extrapolating one probe everywhere.

Some tokens remain outside this support. Uniswap documents that exclusive fees can issue trailing transfers and break invariant accounting, while rebases can change balances independently of transfers. Keep these separate from ordinary inclusive deductions. [Uniswap V2 troubleshooting](https://developers.uniswap.org/docs/protocols/v2/guides/troubleshooting)

Uniswap documents fee-on-transfer incompatibility with its standard V3 routers. A V2 detector must not automatically enable that token for V3 or Carbon. Those execution paths require separate compatibility work. [Uniswap V3 integration issues](https://developers.uniswap.org/docs/protocols/v3/concepts/unsupported-tokens)

## Proposed integration boundary

Discover pools as usual, then probe transfer behaviour during market sync or startup. Save profiles in the existing database and load them into the worker with market state. Tax behaviour is mutable, so it belongs with refreshed observations rather than immutable phase-one metadata. Keep explicit bans as operator overrides.

Profiles should distinguish untested, observed zero deduction, supported measured deduction, blocked transfer, and unsupported behaviour. Store the tested context, amounts, block, and profile revision. A changed or expired profile must invalidate dependent quotes. Startup checks and bounded background refreshes preserve local-only opportunity evaluation; they cannot guarantee immediate detection of an arbitrary token configuration change. Tokens without a usable current profile should remain ineligible.

This can recover opportunities involving predictable transfer deductions. It does not establish that most competing bots avoid them, that their apparent spreads survive taxes and execution costs, or that a successful probe makes an arbitrary token safe.
