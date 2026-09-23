import { type Hex } from 'viem';
import { type V2Variant } from './types';

export function encodeV2RouteData(variant: V2Variant): Hex {
  return variant === 'solidly-stable' ? '0x01' : '0x';
}

export function v2FlashLoanFee(fee: number, amount: bigint): bigint {
  if (!Number.isInteger(fee) || fee < 0 || fee >= 10000 || amount < 0n) throw new Error('Invalid V2 flash fee input');
  const rawFee = BigInt(fee);
  const denominator = 10_000n - rawFee;
  return (amount * rawFee + denominator - 1n) / denominator;
}
