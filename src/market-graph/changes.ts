import { type PairInfo } from '../protocols/v2/types';
import { type V3PoolConfig, type V3PoolState, type V3Tick } from '../protocols/v3/types';
import { type CarbonStrategy } from '../protocols/carbon/types';

export type MarketVersions = Record<string, number>;
export type GraphChanges = {
  pairs: PairInfo[];
  v3: Array<{
    pool: V3PoolConfig;
    state: V3PoolState | null;
    fullRange: boolean;
    replaceTicks: boolean;
    ticks: V3Tick[];
  }>;
  carbon?: readonly CarbonStrategy[];
  versions: MarketVersions;
};
