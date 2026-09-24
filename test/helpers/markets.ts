import { type Address } from 'viem';
import { type PairInfo } from '../../src/protocols/v2/types';
import { estimateTransfer, type TokenTransferProfile } from '../../src/protocols/v2/transfer-fees';

export const address = (id: number): Address => `0x${id.toString(16).padStart(40, '0')}`;

// Synthetic ordinary tokens, not on-chain measurements. Keep the production tax gate enabled.
export function v2Pair(id: number | Address, token0: Address, token1: Address,
  reserve0: bigint, reserve1: bigint, fee = 30): PairInfo {
  const pairAddress = typeof id === 'number' ? address(id) : id;
  const estimate = estimateTransfer([1n, 10n ** 60n].map(requested => ({ requested, debited: requested, credited: requested })));
  const profile = (token: Address): TokenTransferProfile => ({ token, pool: pairAddress,
    executor: address(999), origin: address(999), recipient: address(999), blockNumber: 1n,
    observedAt: 0, validUntil: Number.MAX_SAFE_INTEGER, buy: estimate, sell: estimate, transfer: estimate });
  return { pairAddress, token0, token1, reserve0, reserve1, fee, variant: 'uniswap-v2', scale0: 1n, scale1: 1n,
    transferProfiles: { token0: profile(token0), token1: profile(token1) } };
}
