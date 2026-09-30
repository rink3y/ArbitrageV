import { type Address } from 'viem';
import { type PairInfo } from '../protocols/v2/types';
import { type V3PoolConfig, type V3PoolState, type V3Tick } from '../protocols/v3/types';
import { type CarbonUpdate } from '../protocols/carbon/types';

export type MarketVersions = Record<string, number>;
export type GraphChanges = {
  pairs: PairInfo[];
  removedPairs: Address[];
  v3: Array<{
    pool: V3PoolConfig;
    state: V3PoolState | null;
    fullRange: boolean;
    replaceTicks: boolean;
    ticks: V3Tick[];
  }>;
  removedV3: Address[];
  carbon?: CarbonUpdate;
  versions: MarketVersions;
};
