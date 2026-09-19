import { type Address } from 'viem';

export type CarbonPairMetadata = {
  controller: Address;
  token0: Address;
  token1: Address;
  strategyCount: number;
  feePpm: number;
};

export type CarbonOrder = {
  y: bigint;
  z: bigint;
  A: bigint;
  B: bigint;
};

export type CarbonStrategy = {
  id: bigint;
  owner: Address;
  controller: Address;
  token0: Address;
  token1: Address;
  feePpm: number;
  orders: [CarbonOrder, CarbonOrder];
};

export type CarbonStrategyId = Pick<CarbonStrategy, 'controller' | 'id'>;
// Upserts contain complete strategy states, so queued changes can keep only
// the final state for each controller/ID. Unmentioned strategies are unchanged.
export type CarbonDelta = {
  upserts: readonly CarbonStrategy[];
  removed: readonly CarbonStrategyId[];
};
export type CarbonUpdate =
  | { kind: 'snapshot'; strategies: readonly CarbonStrategy[] }
  | ({ kind: 'delta' } & CarbonDelta);

export function carbonStrategyKey(strategy: CarbonStrategyId): string {
  return `carbon:${strategy.controller.toLowerCase()}:${strategy.id}`;
}
