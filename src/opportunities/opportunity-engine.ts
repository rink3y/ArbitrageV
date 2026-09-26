import { ARBITRAGE_SEARCH_POLICY, CONTRACTS, EXECUTION_POLICY, RUNTIME, CONFIGURED_TOKENS, type TokenConfig } from '../constants';
import { nativeValue } from './native-valuation';
import { isNativeWrapper } from '../tokens';
import { projectOpportunity } from './projected-state';
import { createExecutionPlan, contractPlan } from '../execution/execution-planner';
import { V2_LIVE_POLICY } from '../protocols/v2/config';
import { latency } from '../runtime/latency';
import { searchSplitRoutes, splitGasCost } from './split-routing';
import { compareFractions } from '../fractions';
import { encodeCarbonRouteData } from '../protocols/carbon/execution';
import { flashLoanFee, gasLimitForTransaction } from '../execution/execution-planner';
import { MarketGraph } from '../market-graph/market-graph';
import { sizeRoute } from '../market-graph/route-sizer';
import { type ArbitrageSearchPolicy } from '../market-graph/types';
import { encodeV2RouteData } from '../protocols/v2/execution';
import { receivedAfterTransfer } from '../protocols/v2/transfer-fees';
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
  private selectedAtTokenCount = -1;
  private selectionExpiresAt = 0;
  private selectedTokens: TokenConfig[] = [];
  private readonly strategy: CircularArbitrageStrategy;
  lastSearchStats = { candidates: 0, sized: 0, visitMs: 0, sizingMs: 0 };
  lastSplitStats = { work: 0, evaluated: 0, exhausted: false, elapsedMs: 0, winners: 0 };
  diagnostics: Array<{ path: readonly string[]; pairs: readonly string[]; input: bigint; profit: bigint; netProfit?: bigint; netProfitNative?: bigint; rejection?: string }> = [];

  constructor(
    readonly policy: ArbitrageSearchPolicy = ARBITRAGE_SEARCH_POLICY,
    configuredV3Pools: readonly V3PoolConfig[] = [],
    readonly tokens: readonly TokenConfig[] = CONFIGURED_TOKENS,
  ) {
    for (const limit of [policy.maxCandidatesToSize ?? 64, policy.maxSearchExpansions ?? 50_000]) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Search budgets must be positive integers');
    }
    if ((policy.minProfitNative ?? 0n) < 0n || tokens.some(token => (token.minProfitNative ?? 0n) < 0n))
      throw new Error('Native profit floors must not be negative');
    if (!Number.isSafeInteger(policy.tokenSelectionRefreshMs ?? 86_400_000) || (policy.tokenSelectionRefreshMs ?? 86_400_000) <= 0)
      throw new Error('Token selection refresh must be positive integer milliseconds');
    this.tokenByAddress = new Map(tokens.slice(0, policy.topTokens).map(token => [token.address.toLowerCase(), token]));
    this.startTokens = tokens.slice(0, policy.topTokens).map(token => token.address);
    this.graph = new MarketGraph(policy, configuredV3Pools);
    this.strategy = new CircularArbitrageStrategy(this.graph, policy);
  }

  findOpportunities(request: FindOpportunitiesRequest): ArbitrageSearchResult {
    const measured = latency.enabled;
    this.diagnostics = [];
    if (request.autoSelect) {
      this.selectTokens();
      request = { ...request, startTokens: this.selectedTokens.map(token => token.address) };
    }
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
      if (request.searchDeadline !== undefined && performance.now() >= request.searchDeadline) break;
      if (measured) this.lastSearchStats.sized++;
      const opportunity = this.sizeCandidate(candidate);
      opportunity.observedAt = request.observedAt ?? Date.now();
      const originToken = opportunity.path[0];
      const token = this.tokenByAddress.get(originToken.toLowerCase())!;
      if (request.splitCosts) {
        const key = originToken.toLowerCase();
        const gas = splitGasCost(request.splitCosts, originToken,
          Date.now(), gasLimitForTransaction());
        if (gas !== null) {
          opportunity.netProfit = opportunity.profit - gas;
          if (splitEnabled && opportunity.flashPoolAddress && opportunity.netProfit > (baselineNet.get(key) ?? 0n))
            baselineNet.set(key, opportunity.netProfit);
        }
      }

      let rejected = opportunity.profit <= (token.minProfitNative ?? 0n) ||
          (!!request.splitCosts && (opportunity.netProfit === undefined || opportunity.netProfit <= (token.minProfitNative ?? 0n)));
      if (this.policy.minProfitNative !== undefined && request.splitCosts) {
        const value = this.valueOpportunity(opportunity, request);
        rejected = value === null || (request.aggregateProfit
          ? opportunity.profit <= 0n : value <= (token.minProfitNative ?? this.policy.minProfitNative));
      }
      if (RUNTIME.logLevel === 'debug' && this.diagnostics.length < 64) this.diagnostics.push({
        path: opportunity.path, pairs: opportunity.pairs, input: opportunity.optimalInput,
        profit: opportunity.profit, netProfit: opportunity.netProfit, netProfitNative: opportunity.netProfitNative,
        rejection: !rejected ? undefined : opportunity.profit <= 0n ? 'nonpositive-surplus'
          : this.policy.minProfitNative !== undefined && opportunity.netProfitNative === undefined ? 'missing-funding-or-native-valuation' : 'profit-floor',
      });
      if (rejected) continue;
      this.insertRankedOpportunity(opportunities, opportunity);
    }
    this.lastSearchStats.sizingMs = latency.now() - sizingStarted;

    const started = latency.now();
    const splitResults = searchSplitRoutes(this.graph, [...splitPaths.values()],
      request.autoSelect ? this.selectedTokens : this.tokens, request.splitCosts,
      this.policy.minProfitNative === undefined ? baselineNet : new Map(),
      this.policy.minProfitNative === undefined || !request.splitCosts ? undefined : (profit, token) => {
        const value = nativeValue(this.graph, token, profit);
        return value ? value.amount - gasLimitForTransaction() * request.splitCosts!.gasPriceWei : null;
      }, request.searchDeadline, request.aggregateProfit);
    this.lastSplitStats = { work: splitResults.work, evaluated: splitResults.evaluated, exhausted: splitResults.exhausted,
      elapsedMs: latency.now() - started, winners: splitResults.candidates.length };
    for (const candidate of splitResults.candidates) {
      const branches = candidate.quote.stages.flatMap(stage => stage.branches);
      const pairs = branches.map(branch => branch.pool);
      const protocols = branches.map(branch => branch.protocol);
      const opportunity: ArbitrageOpportunity = { path: candidate.path, pairs, edgeIds: [], protocols,
        fees: branches.map(branch => branch.fee), routeData: branches.map(branch => branch.data),
        optimalInput: candidate.quote.amountIn, profit: candidate.netProfit + candidate.gasCost,
        netProfit: candidate.netProfit, flashPoolAddress: candidate.flashPool.poolAddress,
        observedAt: request.observedAt ?? Date.now(),
        marketVersions: this.graph.marketVersions([...pairs, candidate.flashPool.poolAddress], protocols.includes('carbon')),
        split: { stages: candidate.quote.stages, resources: candidate.quote.resources,
          deadline: BigInt(Math.floor((request.observedAt ?? Date.now()) / 1000) + 30),
          gasLimit: gasLimitForTransaction(), gasPriceWei: request.splitCosts!.gasPriceWei, costsValidUntil: request.splitCosts!.validUntil },
      };
      if (this.policy.minProfitNative !== undefined && request.splitCosts) {
        const value = this.valueOpportunity(opportunity, request);
        const threshold = request.aggregateProfit ? -gasLimitForTransaction() * request.splitCosts.gasPriceWei
          : this.tokenByAddress.get(opportunity.path[0].toLowerCase())?.minProfitNative ?? this.policy.minProfitNative;
        if (value === null || value <= threshold) continue;
      }
      this.insertRankedOpportunity(opportunities, opportunity);
    }
    if (!request.suppressFollowUp && EXECUTION_POLICY.followUpMode !== 'off' && request.splitCosts && opportunities[0]) {
      this.attachFollowUp(opportunities[0], request);
    }
    return opportunities;
  }

  private valueOpportunity(opportunity: ArbitrageOpportunity, request: FindOpportunitiesRequest): bigint | null {
    if (!request.splitCosts || request.splitCosts.validUntil <= Date.now() || !opportunity.flashPoolAddress) return null;
    const projection = isNativeWrapper(opportunity.path[0]) ? null : projectOpportunity(this.graph, opportunity);
    const value = projection
      ? this.graph.withProjectedChanges(projection, () => nativeValue(this.graph, opportunity.path[0], opportunity.profit))
      : nativeValue(this.graph, opportunity.path[0], opportunity.profit,
          [...opportunity.pairs, opportunity.flashPoolAddress]);
    if (!value) return null;
    opportunity.marketVersions = { ...opportunity.marketVersions,
      ...this.graph.marketVersions(value.pools, value.carbon) };
    opportunity.netProfitNative = value.amount - gasLimitForTransaction() * request.splitCosts.gasPriceWei;
    return opportunity.netProfitNative;
  }

  private selectTokens(): void {
    if (this.selectedAtTokenCount === this.graph.tokenCount() && Date.now() < this.selectionExpiresAt) return;
    this.selectedAtTokenCount = this.graph.tokenCount();
    this.selectionExpiresAt = Date.now() + (this.policy.tokenSelectionRefreshMs ?? 86_400_000);
    const selected: TokenConfig[] = [];
    const seen = new Set<string>();
    for (const token of this.tokens) {
      if (this.graph.tokenIndexOf(token.address) === undefined || seen.has(token.address.toLowerCase())) continue;
      selected.push(token); seen.add(token.address.toLowerCase());
      if (selected.length >= this.policy.topTokens) break;
    }
    if (selected.length < this.policy.topTokens) {
      const automatic: Array<{ token: TokenConfig; score: bigint }> = [];
      for (let index = 0; index < this.graph.tokenCount(); index++) {
        const address = this.graph.tokenAddress(index);
        if (seen.has(address.toLowerCase())) continue;
        let score = 0n;
        for (const edgeIndex of this.graph.rankedEdgeIndexes(index, 8)) {
          const capacity = this.graph.maxInputForEdges([edgeIndex]);
          const value = nativeValue(this.graph, address, capacity);
          if (value && value.amount > score) score = value.amount;
        }
        if (score > 0n) automatic.push({ score, token: { address, name: address, decimals: 0, liquidityAmount: 0n } });
      }
      automatic.sort((a, b) => a.score > b.score ? -1 : a.score < b.score ? 1 : 0);
      selected.push(...automatic.slice(0, this.policy.topTokens - selected.length).map(item => item.token));
    }
    this.selectedTokens = selected;
    this.tokenByAddress.clear();
    for (const token of selected) this.tokenByAddress.set(token.address.toLowerCase(), token);
    this.startTokens.splice(0, this.startTokens.length, ...selected.map(token => token.address));
  }

  private attachFollowUp(first: ArbitrageOpportunity, request: FindOpportunitiesRequest): void {
    const projection = projectOpportunity(this.graph, first);
    if (!projection) return;
    const stats = this.lastSearchStats, splitStats = this.lastSplitStats, diagnostics = this.diagnostics;
    try {
      this.graph.withProjectedChanges(projection, () => {
        const candidates = this.findOpportunities({ ...request, autoSelect: false, startTokens: [first.path[0]],
          changedPairs: [...first.pairs, ...projection.pairs.map(pair => pair.pairAddress)],
          suppressFollowUp: true, aggregateProfit: EXECUTION_POLICY.followUpMode === 'batch',
          searchDeadline: performance.now() + EXECUTION_POLICY.followUpSearchMs });
        const next = candidates[0];
        if (!next) return;
        const plan = createExecutionPlan(this.graph, next);
        if (!plan) return;
        next.marketVersions = { ...first.marketVersions, ...next.marketVersions };
        if (EXECUTION_POLICY.followUpMode === 'batch') {
          const finalState = projectOpportunity(this.graph, next);
          if (!finalState) return;
          const combined = this.graph.withProjectedChanges(finalState,
            () => nativeValue(this.graph, first.path[0], first.profit + next.profit));
          if (!combined || combined.amount - gasLimitForTransaction('batch') * request.splitCosts!.gasPriceWei <= (first.netProfitNative ?? 0n)) return;
          next.marketVersions = { ...next.marketVersions, ...this.graph.marketVersions(combined.pools, combined.carbon) };
        }
        first.followUp = next;
        first.followUpPlan = contractPlan(plan);
      });
    } finally { this.lastSearchStats = stats; this.lastSplitStats = splitStats; this.diagnostics = diagnostics; }
  }

  private sizeCandidate(candidate: CandidateRoute): ArbitrageOpportunity {
    const route = {
      path: candidate.path,
      pools: candidate.pairs,
      edgeIds: candidate.edgeIds,
      edgeIndexes: candidate.edgeIndexes,
      protocols: candidate.protocols,
    };
    let routeSwap = this.canUseRouteSwap(candidate);
    let flashPool = routeSwap ? null : this.graph.findBestFlashPoolForToken(candidate.path[0], 1n, candidate.pairs);
    let sized = sizeRoute(this.graph, this.policy, route,
      !routeSwap && flashPool ? amount => flashLoanFee(flashPool!, amount) : undefined);
    if (routeSwap) {
      const first = this.graph.edgeAt(candidate.edgeIndexes[0])!;
      const profile = first.protocol === 'v2' ? first.transferFees?.input : undefined;
      if (!sized.complete || (profile && receivedAfterTransfer(sized.optimalInput, profile.sell, profile.validUntil) !== sized.optimalInput)) {
        routeSwap = false;
        sized = sizeRoute(this.graph, this.policy, route, flashPool ? amount => flashLoanFee(flashPool!, amount) : undefined);
      }
    }
    // Both direct funding choices use the same route gas allowance. When eligible,
    // route-swap funding removes a nonnegative loan fee, so a second sizing pass cannot improve it.
    const sizedFlashPool = !routeSwap && sized.complete
      ? this.graph.findBestFlashPoolForToken(candidate.path[0], sized.optimalInput, candidate.pairs) : null;
    if (sizedFlashPool) {
      const funded = flashPool?.fee === sizedFlashPool.fee && flashPool.protocol === sizedFlashPool.protocol
        ? sized : sizeRoute(this.graph, this.policy, route, amount => flashLoanFee(sizedFlashPool, amount));
      flashPool = sizedFlashPool;
      if (!routeSwap || funded.profit > sized.profit) { routeSwap = false; sized = funded; }
    }
    if (!routeSwap) {
      const actualLender = this.graph.findBestFlashPoolForToken(candidate.path[0], sized.optimalInput, candidate.pairs);
      flashPool = actualLender && actualLender.fee === flashPool?.fee && actualLender.protocol === flashPool.protocol ? actualLender : null;
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
      flashPoolAddress: routeSwap ? candidate.pairs[0] : flashPool?.poolAddress,
      routeSwap,
      marketVersions: this.graph.marketVersions(
        [...candidate.pairs, ...(!routeSwap && flashPool ? [flashPool.poolAddress] : [])],
        candidate.protocols.includes('carbon')
      ),
    };
  }

  private canUseRouteSwap(candidate: CandidateRoute): boolean {
    if (!EXECUTION_POLICY.routeSwapFunding || !CONTRACTS.arbitrage || candidate.pairs.length < 1 ||
        new Set(candidate.pairs.map(pool => pool.toLowerCase())).size !== candidate.pairs.length) return false;
    const first = this.graph.edgeAt(candidate.edgeIndexes[0]);
    if (first?.protocol === 'v3') return this.graph.getV3Pool(first.poolAddress)?.fullRange === true;
    if (first?.protocol !== 'v2') return false;
    if (!first.transferFees) return !V2_LIVE_POLICY.transferFees;
    return first.transferFees.input.executor.toLowerCase() === CONTRACTS.arbitrage.toLowerCase() &&
      first.transferFees.input.sell.status === 'measured' && first.transferFees.input.sell.feeBps === 0 &&
      first.transferFees.input.validUntil > Date.now();
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
    if (a.netProfitNative !== undefined || b.netProfitNative !== undefined) {
      const left = a.netProfitNative ?? -1n, right = b.netProfitNative ?? -1n;
      return left > right ? 1 : left < right ? -1 : 0;
    }
    const left = a.netProfit ?? a.profit, right = b.netProfit ?? b.profit;
    return left > right ? 1 : left < right ? -1 : 0;
  }
}
