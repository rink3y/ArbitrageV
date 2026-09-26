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
  v2RouteFlash?: boolean;
  routeSwap?: boolean;
  netProfitNative?: bigint;
  followUp?: ArbitrageOpportunity;
  followUpPlan?: import('../execution/execution-planner').ContractPlan;
  observedAt?: number;
  netProfit?: bigint;
  split?: {
    stages: SplitStage[]; resources: string[];
    deadline: bigint; gasLimit: bigint;
    gasPriceWei: bigint; costsValidUntil: number;
  };
};

export type FindOpportunitiesRequest = {
  startTokens: Address[];
  changedPairs?: readonly string[];
  observedAt?: number;
  splitCosts?: SplitCosts;
  autoSelect?: boolean;
  suppressFollowUp?: boolean;
  searchDeadline?: number;
};

export type ArbitrageSearchResult = ArbitrageOpportunity[];
