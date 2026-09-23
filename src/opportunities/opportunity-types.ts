import { type Address } from 'viem';
import { type MarketEdgeId, type MarketProtocol } from '../market-graph/types';
import { type MarketVersions } from '../market-graph/changes';
import { type SplitCosts, type SplitStage } from './split-routing';

export type CandidateRoute = {
  path: Address[];
  pairs: Address[];
  edgeIds: MarketEdgeId[];
  edgeIndexes: number[];
  protocols: MarketProtocol[];
};

export type ArbitrageOpportunity = Omit<CandidateRoute, 'edgeIndexes'> & {
  edgeIndexes?: number[];
  profit: bigint;
  optimalInput: bigint;
  fees: number[];
  routeData: `0x${string}`[];
  marketVersions?: MarketVersions;
  flashPoolAddress?: Address;
  observedAt?: number;
  netProfit?: bigint;
  split?: {
    mode: 'shadow' | 'live'; stages: SplitStage[]; resources: string[];
    minSurplusAfterRepayment: bigint; deadline: bigint; gasLimit: bigint;
    gasPriceWei: bigint; costsValidUntil: number;
  };
};

export type FindOpportunitiesRequest = {
  startTokens: Address[];
  changedPairs?: readonly string[];
  observedAt?: number;
  splitCosts?: SplitCosts;
};

export type ArbitrageSearchResult = ArbitrageOpportunity[];
