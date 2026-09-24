import { ARBITRAGE_SEARCH_POLICY, EXECUTION_POLICY, RUNTIME, TOKENS, type TokenConfig } from '../constants';
import { latency } from '../runtime/latency';
import { searchSplitRoutes, splitGasCost } from './split-routing';
import { compareFractions } from '../fractions';
import { encodeCarbonRouteData } from '../protocols/carbon/execution';
import { flashLoanFee } from '../execution/execution-planner';
import { MarketGraph } from '../market-graph/market-graph';
import { sizeRoute } from '../market-graph/route-sizer';
import { type ArbitrageSearchPolicy } from '../market-graph/types';
import { encodeV2RouteData } from '../protocols/v2/execution';
import { type V3PoolConfig } from '../protocols/v3/types';
import { CircularArbitrageStrategy } from '../strategies/circular-arbitrage';
import {
  type ArbitrageOpportunity,
  type ArbitrageSearchResult,
  type CandidateRoute,
  type FindOpportunitiesRequest,
} from './opportunity-types';

export class OpportunityEngine {
  readonly graph: MarketGraph;
  private readonly tokenByAddress: Map<string, TokenConfig>;
  readonly startTokens: TokenConfig['address'][];
  private readonly strategy: CircularArbitrageStrategy;
  lastSearchStats = { candidates: 0, sized: 0, visitMs: 0, sizingMs: 0 };
  lastSplitStats = { work: 0, evaluated: 0, exhausted: false, elapsedMs: 0, winners: 0 };
  diagnostics: Array<{ path: readonly string[]; pairs: readonly string[]; input: bigint; profit: bigint; netProfit?: bigint; rejection?: string }> = [];

  constructor(
    readonly policy: ArbitrageSearchPolicy = ARBITRAGE_SEARCH_POLICY,
    configuredV3Pools: readonly V3PoolConfig[] = [],
    readonly tokens: readonly TokenConfig[] = TOKENS,
  ) {
    for (const limit of [policy.maxCandidatesToSize ?? 64, policy.maxSearchExpansions ?? 50_000]) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Search budgets must be positive integers');
    }
    this.tokenByAddress = new Map(tokens.slice(0, policy.topTokens).map(token => [token.address.toLowerCase(), token]));
    this.startTokens = tokens.slice(0, policy.topTokens).map(token => token.address);
    this.graph = new MarketGraph(policy, configuredV3Pools);
    this.strategy = new CircularArbitrageStrategy(this.graph, policy);
  }

  findOpportunities(request: FindOpportunitiesRequest): ArbitrageSearchResult {
    const measured = latency.enabled;
    this.diagnostics = [];
    request = { ...request, startTokens: request.startTokens.filter(token => this.tokenByAddress.has(token.toLowerCase())) };
    const splitEnabled = this.policy.splitRouting === 'live';
    const opportunities: ArbitrageOpportunity[] = [];
    const shortlist: Array<{ candidate: CandidateRoute; numerator: bigint; denominator: bigint }> = [];
    const limit = this.policy.maxCandidatesToSize ?? 64;
    const splitPaths = new Map<string, CandidateRoute['path']>();
    const baselineNet = new Map<string, bigint>();
    this.lastSearchStats = { candidates: 0, sized: 0, visitMs: 0, sizingMs: 0 };
    const visitStarted = latency.now();
    this.strategy.visitCandidates(request, candidate => {
      if (measured) this.lastSearchStats.candidates++;
      if (splitEnabled && splitPaths.size < limit && candidate.path.length <= Math.min(this.policy.maxRouteEdges, 3) + 1) {
        splitPaths.set(candidate.path.map(token => token.toLowerCase()).join(':'), candidate.path);
      }
      let numerator = 1n;
      let denominator = 1n;
      for (const index of candidate.edgeIndexes) {
        const edge = this.graph.edgeAt(index)!;
        numerator *= edge.rateNumerator;
        denominator *= edge.rateDenominator;
      }
      let index = shortlist.length;
      while (index > 0 && compareFractions(numerator, denominator, shortlist[index - 1].numerator, shortlist[index - 1].denominator) > 0) index--;
      if (index >= limit) return;
      shortlist.splice(index, 0, { candidate, numerator, denominator });
      if (shortlist.length > limit) shortlist.pop();
    });
    this.lastSearchStats.visitMs = latency.now() - visitStarted;

    const sizingStarted = latency.now();
    for (const { candidate } of shortlist) {
      if (measured) this.lastSearchStats.sized++;
      const opportunity = this.sizeCandidate(candidate);
      opportunity.observedAt = request.observedAt ?? Date.now();
      const originToken = opportunity.path[0];
      const token = this.tokenByAddress.get(originToken.toLowerCase())!;
      if (request.splitCosts) {
        const key = originToken.toLowerCase();
        const gas = splitGasCost(request.splitCosts, originToken);
        if (gas !== null) {
          opportunity.netProfit = opportunity.profit - gas;
          if (splitEnabled && opportunity.flashPoolAddress && opportunity.netProfit > (baselineNet.get(key) ?? 0n))
            baselineNet.set(key, opportunity.netProfit);
        }
      }

      const rejected = opportunity.profit <= token.minProfit ||
          (!!request.splitCosts && (opportunity.netProfit === undefined || opportunity.netProfit <= token.minProfit));
      if (RUNTIME.logLevel === 'debug' && this.diagnostics.length < 64) this.diagnostics.push({
        path: opportunity.path, pairs: opportunity.pairs, input: opportunity.optimalInput,
        profit: opportunity.profit, netProfit: opportunity.netProfit,
        rejection: opportunity.profit <= token.minProfit ? 'gross-profit-floor'
          : rejected ? opportunity.netProfit === undefined ? 'missing-gas-conversion' : 'net-profit-floor' : undefined,
      });
      if (rejected) continue;
      this.insertRankedOpportunity(opportunities, opportunity);
    }
    this.lastSearchStats.sizingMs = latency.now() - sizingStarted;

    const started = latency.now();
    const splitResults = searchSplitRoutes(this.graph, [...splitPaths.values()], this.tokens, request.splitCosts, baselineNet);
    this.lastSplitStats = { work: splitResults.work, evaluated: splitResults.evaluated, exhausted: splitResults.exhausted,
      elapsedMs: latency.now() - started, winners: splitResults.candidates.length };
    for (const candidate of splitResults.candidates) {
      const branches = candidate.quote.stages.flatMap(stage => stage.branches);
      const pairs = branches.map(branch => branch.pool);
      const protocols = branches.map(branch => branch.protocol);
      opportunities.push({ path: candidate.path, pairs, edgeIds: [], protocols,
        fees: branches.map(branch => branch.fee), routeData: branches.map(branch => branch.data),
        optimalInput: candidate.quote.amountIn, profit: candidate.netProfit + candidate.gasCost,
        netProfit: candidate.netProfit, flashPoolAddress: candidate.flashPool.poolAddress,
        observedAt: request.observedAt ?? Date.now(),
        marketVersions: this.graph.marketVersions([...pairs, candidate.flashPool.poolAddress], protocols.includes('carbon')),
        split: { stages: candidate.quote.stages, resources: candidate.quote.resources,
          deadline: BigInt(Math.floor((request.observedAt ?? Date.now()) / 1000) + 30),
          gasLimit: EXECUTION_POLICY.gasLimit, gasPriceWei: request.splitCosts!.gasPriceWei, costsValidUntil: request.splitCosts!.validUntil },
      });
    }
    return opportunities;
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
      flashPoolAddress: flashPool?.poolAddress,
      marketVersions: this.graph.marketVersions(
        [...candidate.pairs, ...(flashPool ? [flashPool.poolAddress] : [])],
        candidate.protocols.includes('carbon')
      ),
    };
  }

  private executionMetadata(candidate: CandidateRoute, amountIn: bigint): { fees: number[]; routeData: `0x${string}`[] } {
    const fees: number[] = [];
    const routeData: `0x${string}`[] = [];
    let amount = amountIn;

    candidate.edgeIds.forEach((edgeId, index) => {
      const edgeIndex = candidate.edgeIndexes[index];
      const edge = this.graph.edgeAt(edgeIndex);
      if (!edge) throw new Error(`Missing market edge ${edgeId}`);

      fees.push(edge.fee);
      routeData.push(edge.protocol === 'carbon'
        ? this.encodeCarbonRouteData(edgeIndex, amount)
        : edge.protocol === 'v2'
          ? encodeV2RouteData(edge.variant, !!edge.transferFees)
          : '0x');

      const quote = this.graph.quoteEdgeAt(edgeIndex, amount);
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
      const edge = this.graph.edgeAt(candidate.edgeIndexes[index]);
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
    const aScale = this.tokenByAddress.get(a.path[0].toLowerCase())?.minProfit ?? 1n;
    const bScale = this.tokenByAddress.get(b.path[0].toLowerCase())?.minProfit ?? 1n;
    const left = (a.netProfit ?? a.profit) * bScale;
    const right = (b.netProfit ?? b.profit) * aScale;
    return left > right ? 1 : left < right ? -1 : 0;
  }
}
