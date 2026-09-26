import { type Address } from 'viem';

export type TransferSample = { requested: bigint; debited: bigint; credited: bigint };
export type TransferEstimate = {
  status: 'measured' | 'unsupported' | 'unknown';
  minAmount: bigint;
  maxAmount: bigint;
  feeBps: number;
  samples: TransferSample[];
};
export type TokenTransferProfile = {
  token: Address; pool: Address; executor: Address; origin: Address; recipient: Address;
  blockNumber: bigint; observedAt: number; validUntil: number;
  blockHash?: `0x${string}`;
  probeErrors?: string[];
  buy: TransferEstimate; sell: TransferEstimate; transfer: TransferEstimate;
};
export type PairTransferProfiles = { token0: TokenTransferProfile; token1: TokenTransferProfile };
export type EdgeTransferFees = { input: TokenTransferProfile; output: TokenTransferProfile };

export function compactTransferProfiles(profiles: PairTransferProfiles): PairTransferProfiles {
  const compact = (p: TokenTransferProfile): TokenTransferProfile => ({ ...p, probeErrors: undefined,
    buy: { ...p.buy, samples: [] }, sell: { ...p.sell, samples: [] }, transfer: { ...p.transfer, samples: [] } });
  return { token0: compact(profiles.token0), token1: compact(profiles.token1) };
}

// A fitted estimate over observed sizes, never a claim about all token transfers.
export function estimateTransfer(samples: TransferSample[]): TransferEstimate {
  const empty: TransferEstimate = { status: 'unknown', minAmount: 0n, maxAmount: 0n, feeBps: 0, samples };
  if (samples.length < 2 || samples.some(s => s.requested <= 0n)) return empty;
  if (samples.some(s => s.debited !== s.requested || s.credited <= 0n || s.credited > s.requested)) return { ...empty, status: 'unsupported' };
  const fees = samples.map(s => Number(((s.requested - s.credited) * 10000n + s.requested - 1n) / s.requested));
  if (Math.max(...fees) >= 10000 || Math.max(...fees) - Math.min(...fees) > 1) return { ...empty, status: 'unsupported' };
  const amounts = samples.map(s => s.requested);
  const minAmount = amounts.reduce((a, b) => a < b ? a : b);
  const maxAmount = amounts.reduce((a, b) => a > b ? a : b);
  if (minAmount === maxAmount) return empty;
  return { status: 'measured', minAmount, maxAmount, feeBps: Math.max(...fees), samples };
}

export function receivedAfterTransfer(amount: bigint, estimate: TransferEstimate, validUntil: number, now = Date.now()): bigint {
  if (estimate.status !== 'measured' || now >= validUntil || amount < estimate.minAmount || amount > estimate.maxAmount) return 0n;
  return amount * BigInt(10000 - estimate.feeBps) / 10000n;
}

export function profilesCurrent(profiles: PairTransferProfiles, now = Date.now()): boolean {
  return [profiles.token0, profiles.token1].every(p => p.validUntil > now && p.buy.status === 'measured' && p.sell.status === 'measured');
}
