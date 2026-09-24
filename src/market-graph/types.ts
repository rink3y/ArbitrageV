import { type Address } from 'viem';
import { type CarbonOrder } from '../protocols/carbon/types';
import { type SwapDirection, type V2Variant } from '../protocols/v2/types';
import { type EdgeTransferFees } from '../protocols/v2/transfer-fees';

export type MarketProtocol = 'v2' | 'v3' | 'carbon';

export type ArbitrageSearchPolicy = {
  splitRouting?: 'off' | 'live';
  splitSearchMs?: number;
  topTokens: number;
  allowedProtocols: readonly MarketProtocol[];
  allowProtocolMixing: boolean;
  maxRouteEdges: number;
  beamWidth: number;
  optimizationIterations: number;
  maxInputReserveFraction: bigint;
  maxOpportunities: number;
  maxCandidatesToSize?: number;
  maxSearchExpansions?: number;
};

export type MarketEdgeId = string;

export type MarketEdge = {
  id: MarketEdgeId;
  protocol: MarketProtocol;
  from: Address;
  to: Address;
  poolAddress: Address;
  direction: SwapDirection;
  fee: number;
  rateNumerator: bigint;
  rateDenominator: bigint;
  liquidity: bigint;
};

export type V2MarketEdge = MarketEdge & {
  transferFees?: EdgeTransferFees;
  protocol: 'v2';
  reserveIn: bigint;
  reserveOut: bigint;
  variant: V2Variant;
  scaleIn: bigint;
  scaleOut: bigint;
};

export type V3MarketEdge = MarketEdge & {
  protocol: 'v3';
  sqrtPriceX96: bigint;
};

export type CarbonSingleMarketEdge = MarketEdge & {
  protocol: 'carbon';
  carbonKind: 'single';
  strategyId: bigint;
  rawFrom: Address;
  rawTo: Address;
  order: CarbonOrder;
};

export type CarbonGroupOrder = {
  strategyId: bigint;
  orderIndex: 0 | 1;
  order: CarbonOrder;
};

export type CarbonGroupedMarketEdge = MarketEdge & {
  protocol: 'carbon';
  carbonKind: 'group';
  rawFrom: Address;
  rawTo: Address;
  orders: CarbonGroupOrder[];
};

export type CarbonMarketEdge = CarbonSingleMarketEdge | CarbonGroupedMarketEdge;

export type AnyMarketEdge = V2MarketEdge | V3MarketEdge | CarbonMarketEdge;

export type MarketRoute = {
  path: Address[];
  pools: Address[];
  edgeIds: MarketEdgeId[];
  edgeIndexes?: number[];
  protocols: MarketProtocol[];
};

export type MarketRouteQuote = {
  amountIn: bigint;
  amountOut: bigint;
  profit: bigint;
  complete: boolean;
};

export type MarketSizedRoute = {
  profit: bigint;
  optimalInput: bigint;
  complete: boolean;
};

export type FlashPoolCandidate = {
  protocol: MarketProtocol;
  poolAddress: Address;
  fee: number;
  liquidity: bigint;
};

export function protocolAllowed(policy: ArbitrageSearchPolicy, protocol: MarketProtocol): boolean {
  return policy.allowedProtocols.includes(protocol);
}

export function transitionAllowed(
  policy: ArbitrageSearchPolicy,
  previous: MarketProtocol | null,
  next: MarketProtocol
): boolean {
  if (!previous) return protocolAllowed(policy, next);
  if (!protocolAllowed(policy, next)) return false;
  return policy.allowProtocolMixing || previous === next;
}
