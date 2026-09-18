import { type Address } from 'viem';
import { ARBITRAGE_SEARCH_POLICY, TOKENS } from '../constants';
import { type CarbonStrategy } from '../protocols/carbon/types';
import { encodeCarbonRouteData } from '../protocols/carbon/execution';
import { flashLoanFee } from '../execution/execution-planner';
import { MarketGraph } from '../market-graph/market-graph';
import { sizeRoute } from '../market-graph/route-sizer';
import { type ArbitrageSearchPolicy, type FlashPoolCandidate } from '../market-graph/types';
import { type PairInfo, type ReserveUpdate } from '../protocols/v2/types';
import { encodeV2RouteData } from '../protocols/v2/execution';
import {
  type V3BitmapWord,
  type V3BitmapWordUpdate,
  type V3PoolConfig,
  type V3PoolInfo,
  type V3Snapshot,
  type V3PoolUpdate,
  type V3Tick,
  type V3TickUpdate,
} from '../protocols/v3/types';
import { CircularArbitrageStrategy } from '../strategies/circular-arbitrage';
import {
  type ArbitrageOpportunity,
  type ArbitrageSearchResult,
  type CandidateRoute,
  type FindOpportunitiesRequest,
} from './opportunity-types';

const TOKEN_BY_ADDRESS = new Map(TOKENS.map(token => [token.address.toLowerCase(), token]));

export class OpportunityEngine {
  private readonly graph: MarketGraph;
  private readonly strategy: CircularArbitrageStrategy;

  constructor(
    private readonly policy: ArbitrageSearchPolicy = ARBITRAGE_SEARCH_POLICY,
    configuredV3Pools: readonly V3PoolConfig[] = []
  ) {
    this.graph = new MarketGraph(policy, configuredV3Pools);
    this.strategy = new CircularArbitrageStrategy(this.graph, policy);
  }

  addPair(pair: PairInfo): void {
    this.graph.addPair(pair);
  }

  updateReserves(updates: ReserveUpdate[]): void {
    this.graph.updateReserves(updates);
  }

  addV3Pool(pool: V3PoolConfig): void {
    this.graph.addV3Pool(pool);
  }

  replaceV3Snapshot(pool: V3PoolConfig, snapshot: V3Snapshot): void {
    this.graph.replaceV3Snapshot(pool, snapshot);
  }

  invalidateV3Pool(poolAddress: Address): void {
    this.graph.invalidateV3Pool(poolAddress);
  }

  updateV3PoolStates(updates: V3PoolUpdate[]): void {
    this.graph.updateV3PoolStates(updates);
  }

  updateV3Ticks(updates: V3TickUpdate[]): void {
    this.graph.updateV3Ticks(updates);
  }

  updateV3BitmapWords(updates: V3BitmapWordUpdate[]): void {
    this.graph.updateV3BitmapWords(updates);
  }

  setCarbonStrategies(strategies: readonly CarbonStrategy[]): void {
    this.graph.setCarbonStrategies(strategies);
  }

  getV3PoolAddresses(): Address[] {
    return this.graph.getV3PoolAddresses();
  }

  getV3Pools(): V3PoolInfo[] {
    return this.graph.getV3Pools();
  }

  getV3Pool(poolAddress: Address): V3PoolInfo | null {
    return this.graph.getV3Pool(poolAddress);
  }

  getV3InitializedTicks(poolAddress: Address): V3Tick[] {
    return this.graph.getV3InitializedTicks(poolAddress);
  }

  getV3BitmapWords(poolAddress: Address): V3BitmapWord[] {
    return this.graph.getV3BitmapWords(poolAddress);
  }

  v3PoolNeedsRefresh(poolAddress: Address): boolean {
    return this.graph.v3PoolNeedsRefresh(poolAddress);
  }

  findOpportunities(request: FindOpportunitiesRequest): ArbitrageSearchResult {
    const opportunities: ArbitrageOpportunity[] = [];

    this.strategy.visitCandidates(request, candidate => {
      const opportunity = this.sizeCandidate(candidate);
      const originToken = opportunity.path[0];
      const token = TOKEN_BY_ADDRESS.get(originToken.toLowerCase());

      if (!token) {
        throw new Error(`No token config found for ${originToken}. Please update TOKENS in constants.ts.`);
      }

      if (opportunity.profit <= token.minProfit) return;
      this.insertRankedOpportunity(opportunities, opportunity);
    });

    return opportunities;
  }

  findBestFlashPoolForToken(
    token: Address,
    amountIn: bigint,
    excludePools: Address[] = []
  ): FlashPoolCandidate | null {
    return this.graph.findBestFlashPoolForToken(token, amountIn, excludePools);
  }

  getPairAddresses(): Address[] {
    return this.graph.getPairAddresses();
  }

  getAllPairs(): PairInfo[] {
    return this.graph.getAllPairs();
  }

  private sizeCandidate(candidate: CandidateRoute): ArbitrageOpportunity {
    const route = {
      path: candidate.path,
      pools: candidate.pairs,
      edgeIds: candidate.edgeIds,
      edgeIndexes: candidate.edgeIndexes,
      protocols: candidate.protocols,
    };
    let flashPool = this.graph.findBestFlashPoolForToken(candidate.path[0], 1n, candidate.pairs);
    let sized = sizeRoute(
      this.graph,
      this.policy,
      route,
      flashPool ? amount => flashLoanFee(flashPool!, amount) : undefined
    );
    const sizedFlashPool = sized.complete
      ? this.graph.findBestFlashPoolForToken(candidate.path[0], sized.optimalInput, candidate.pairs)
      : null;
    if (sizedFlashPool && sizedFlashPool.poolAddress !== flashPool?.poolAddress) {
      flashPool = sizedFlashPool;
      sized = sizeRoute(this.graph, this.policy, route, amount => flashLoanFee(flashPool!, amount));
    }
    const { profit, optimalInput, complete } = sized;
    const { fees, routeData } = complete
      ? this.executionMetadata(candidate, optimalInput)
      : this.emptyExecutionMetadata(candidate);

    return {
      ...candidate,
      profit: complete ? profit : 0n,
      optimalInput: complete ? optimalInput : 0n,
      fees,
      routeData,
    };
  }

  private executionMetadata(candidate: CandidateRoute, amountIn: bigint): { fees: number[]; routeData: `0x${string}`[] } {
    const fees: number[] = [];
    const routeData: `0x${string}`[] = [];
    let amount = amountIn;

    candidate.edgeIds.forEach((edgeId, index) => {
      const edgeIndex = candidate.edgeIndexes?.[index];
      const edge = edgeIndex !== undefined ? this.graph.edgeAt(edgeIndex) : this.graph.edge(edgeId);
      if (!edge) throw new Error(`Missing market edge ${edgeId}`);

      fees.push(edge.fee);
      routeData.push(edge.protocol === 'carbon' && edgeIndex !== undefined
        ? this.encodeCarbonRouteData(edgeIndex, amount)
        : edge.protocol === 'v2'
          ? encodeV2RouteData(edge.variant)
          : '0x');

      const quote = edgeIndex !== undefined
        ? this.graph.quoteEdgeAt(edgeIndex, amount)
        : this.graph.quote({ path: [], pools: [], edgeIds: [edgeId], protocols: [edge.protocol] }, amount);
      amount = quote.amountOut;
    });

    return { fees, routeData };
  }

  private encodeCarbonRouteData(edgeIndex: number, amountIn: bigint): `0x${string}` {
    const execution = this.graph.carbonExecution(edgeIndex, amountIn);
    if (!execution) throw new Error(`Missing Carbon execution data for edge ${edgeIndex}`);

    return encodeCarbonRouteData(execution);
  }

  private emptyExecutionMetadata(candidate: CandidateRoute): { fees: number[]; routeData: `0x${string}`[] } {
    const fees: number[] = [];
    const routeData: `0x${string}`[] = [];

    candidate.edgeIds.forEach((edgeId, index) => {
      const edge = candidate.edgeIndexes
        ? this.graph.edgeAt(candidate.edgeIndexes[index])
        : this.graph.edge(edgeId);
      if (!edge) throw new Error(`Missing market edge ${edgeId}`);
      fees.push(edge.fee);
      routeData.push('0x');
    });

    return { fees, routeData };
  }

  private insertRankedOpportunity(
    opportunities: ArbitrageOpportunity[],
    opportunity: ArbitrageOpportunity
  ): void {
    let index = opportunities.length;

    while (index > 0 && this.compareOpportunityValue(opportunity, opportunities[index - 1]) > 0) {
      index--;
    }

    if (index >= this.policy.maxOpportunities) return;

    opportunities.splice(index, 0, opportunity);
    opportunities.length = Math.min(opportunities.length, this.policy.maxOpportunities);
  }

  private compareOpportunityValue(a: ArbitrageOpportunity, b: ArbitrageOpportunity): number {
    const aScale = TOKEN_BY_ADDRESS.get(a.path[0].toLowerCase())?.minProfit ?? 1n;
    const bScale = TOKEN_BY_ADDRESS.get(b.path[0].toLowerCase())?.minProfit ?? 1n;
    const left = a.profit * bScale;
    const right = b.profit * aScale;
    return left > right ? 1 : left < right ? -1 : 0;
  }
}
