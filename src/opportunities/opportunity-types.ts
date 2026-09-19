import { type Address } from 'viem';
import { type MarketEdgeId, type MarketProtocol } from '../market-graph/types';
import { type MarketVersions } from '../market-graph/changes';

export type CandidateRoute = {
  path: Address[];
  pairs: Address[];
  edgeIds: MarketEdgeId[];
  edgeIndexes?: number[];
  protocols: MarketProtocol[];
};

export type ArbitrageOpportunity = CandidateRoute & {
  profit: bigint;
  optimalInput: bigint;
  fees: number[];
  routeData: `0x${string}`[];
  marketVersions?: MarketVersions;
  flashPoolAddress?: Address;
  observedAt?: number;
};

export type FindOpportunitiesRequest = {
  startTokens: Address[];
  changedPairs?: readonly string[];
  observedAt?: number;
};

export type ArbitrageSearchResult = ArbitrageOpportunity[];
