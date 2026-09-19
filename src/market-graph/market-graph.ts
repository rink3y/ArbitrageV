import { type Address } from 'viem';
import { ARBITRAGE_SEARCH_POLICY, TOKENS } from '../constants';
import { type CarbonStrategy } from '../protocols/carbon/types';
import { graphToken } from '../tokens';
import {
  type PairInfo,
  type ReserveUpdate,
  type SwapDirection,
} from '../protocols/v2/types';
import {
  type V3PoolConfig,
  type V3PoolInfo,
  type V3Snapshot,
  type V3PoolUpdate,
  type V3Tick,
  type V3TickUpdate,
} from '../protocols/v3/types';
import { compareFractions } from '../fractions';
import { quoteV2ExactInput, v2MarginalRate } from '../protocols/v2/quote';
import {
  carbonMarginalRate,
  carbonSourceAmountForFullOrder,
  quoteCarbonExactInput,
  CarbonGroupQuoter,
  type CarbonAllocation,
} from '../protocols/carbon/quote';
import { Q96, quoteV3MultiRangeExactInput, V3_FEE_DENOMINATOR } from '../protocols/v3/quote';
import { protocolPlugin } from '../protocols/registry';
import { type GraphChanges, type MarketVersions } from './changes';
import {
  type AnyMarketEdge,
  type ArbitrageSearchPolicy,
  type CarbonGroupOrder,
  type CarbonMarketEdge,
  type FlashPoolCandidate,
  type MarketEdgeId,
  type MarketProtocol,
  type MarketRoute,
  type MarketRouteQuote,
  protocolAllowed,
} from './types';

type TokenSlot = {
  address: Address;
  edgeIndexes: number[];
  incomingEdgeIndexes: number[];
  pools: Map<number, number[]>;
};

type EdgeSlot = {
  edge: AnyMarketEdge;
  tokenIndex: number;
  toTokenIndex: number;
  poolIndex: number;
};

type IndexedEdgeCache = {
  limit: number;
  edgeIndexes: number[];
};

const Q192 = Q96 * Q96;
const MAX_GROUPED_CARBON_ORDERS = 8;
const DEFAULT_TOKEN_VALUE_SCALE = 10n ** 18n;
const TOKEN_VALUE_SCALE = new Map(TOKENS.map(token => [token.address.toLowerCase(), token.minProfit]));

class AddressRegistry {
  private readonly indexes = new Map<string, number>();
  private readonly addresses: string[] = [];

  get(address: Address | string): number | undefined {
    return this.indexes.get(this.key(address));
  }

  getOrAdd(address: Address | string): number {
    const key = this.key(address);
    const existing = this.indexes.get(key);
    if (existing !== undefined) return existing;

    const index = this.addresses.length;
    this.indexes.set(key, index);
    this.addresses.push(address);
    return index;
  }

  address(index: number): string {
    return this.addresses[index];
  }

  key(address: Address | string): string {
    return address.toLowerCase();
  }
}

export class MarketGraph {
  private readonly versions = new Map<string, number>();
  private readonly dirtyPairs = new Set<string>();
  private readonly dirtyV3 = new Map<string, Set<number> | null>();
  private carbonStrategies: readonly CarbonStrategy[] = [];
  private carbonDirty = false;
  private feedReady = true;

  setFeedReady(ready: boolean): void {
    this.feedReady = ready;
    this.touch('$feed');
  }

  marketVersions(addresses: readonly string[], carbon = false): MarketVersions {
    return Object.fromEntries(['$feed', ...addresses.map(address => address.toLowerCase()), ...(carbon ? ['$carbon'] : [])]
      .map(key => [key, this.versions.get(key) ?? 0]));
  }

  matchesVersions(versions: MarketVersions): boolean {
    return this.feedReady && Object.entries(versions).every(([key, value]) => (this.versions.get(key) ?? 0) === value);
  }

  // One full transfer at startup. Thereafter send absolute pool states and only
  // changed ticks, coalesced by pool/tick while the search worker is occupied.
  takeChanges(full = false): GraphChanges {
    const pairs = (full ? this.getAllPairs() : [...this.dirtyPairs].map(key => this.pairs[this.poolRegistry.get(key)!]!)).map(pair => ({ ...pair }));
    const v3 = (full ? this.getV3Pools() : [...this.dirtyV3.keys()].map(key => this.getV3Pool(key as Address)!)).map(pool => {
      const indexes = this.dirtyV3.get(pool.address.toLowerCase());
      const replaceTicks = full || indexes === null;
      const { state, ticks, bitmapWords: _bitmap, fullRange, ...config } = pool;
      return { pool: config, state, fullRange: fullRange === true, replaceTicks,
        ticks: replaceTicks ? [...ticks.values()] : [...indexes ?? []].map(index => ticks.get(index) ?? { index, liquidityGross: 0n, liquidityNet: 0n }) };
    });
    const keys = [...pairs.map(pair => pair.pairAddress), ...v3.map(item => item.pool.address)];
    const changes: GraphChanges = { pairs, v3, versions: this.marketVersions(keys, full || this.carbonDirty) };
    if (full || this.carbonDirty) changes.carbon = this.carbonStrategies;
    this.dirtyPairs.clear();
    this.dirtyV3.clear();
    this.carbonDirty = false;
    return changes;
  }

  applyChanges(changes: GraphChanges): void {
    for (const pair of changes.pairs) {
      const index = this.poolRegistry.get(pair.pairAddress);
      if (index !== undefined && this.pairs[index]) this.updateReserves([pair]);
      else this.addPair(pair);
    }
    for (const change of changes.v3) {
      this.addV3Pool(change.pool);
      const pool = this.getV3Pool(change.pool.address)!;
      if (change.replaceTicks) pool.ticks.clear();
      this.updateV3Ticks([{ poolAddress: pool.address, ticks: change.ticks }]);
      pool.fullRange = change.fullRange;
      if (change.state) this.updateV3PoolStates([{ poolAddress: pool.address, ...change.state }]);
    }
    if (changes.carbon) this.setCarbonStrategies(changes.carbon);
    this.dirtyPairs.clear(); this.dirtyV3.clear(); this.carbonDirty = false;
    for (const [key, version] of Object.entries(changes.versions)) this.versions.set(key, version);
  }

  private touch(address: string): void {
    const key = address.toLowerCase();
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }

  private touchV3(address: string, ticks: readonly V3Tick[] = []): void {
    const key = address.toLowerCase();
    this.touch(key);
    if (this.dirtyV3.get(key) === null) return;
    const indexes = this.dirtyV3.get(key) ?? new Set<number>();
    for (const tick of ticks) indexes.add(tick.index);
    this.dirtyV3.set(key, indexes);
  }
  private readonly tokenRegistry = new AddressRegistry();
  private readonly poolRegistry = new AddressRegistry();
  private readonly tokens: TokenSlot[] = [];
  private readonly edgeIndexes = new Map<MarketEdgeId, number>();
  private readonly edges: EdgeSlot[] = [];
  private readonly rankedEdgesCache = new Map<number, IndexedEdgeCache>();
  private readonly flashEdgesCache = new Map<number, number[]>();
  private readonly hopDistancesCache = new Map<number, Int32Array>();
  private readonly pairs: Array<PairInfo | undefined> = [];
  private readonly v3Pools: Array<V3PoolInfo | undefined> = [];
  private readonly v3TicksCache: Array<V3Tick[] | undefined> = [];
  private readonly carbonEdgeIds = new Set<MarketEdgeId>();
  private readonly carbonGroupQuoter = new CarbonGroupQuoter();

  constructor(
    private readonly policy: ArbitrageSearchPolicy = ARBITRAGE_SEARCH_POLICY,
    configuredV3Pools: readonly V3PoolConfig[] = []
  ) {
    for (const pool of configuredV3Pools) this.addV3Pool(pool);
  }

  addPair(pair: PairInfo): void {
    if ((pair.reserve0 === 0n || pair.reserve1 === 0n) && this.poolRegistry.get(pair.pairAddress) === undefined) return;
    const poolIndex = this.poolIndex(pair.pairAddress);
    this.pairs[poolIndex] = pair;
    this.upsertV2Edges(pair, poolIndex);
    this.touch(pair.pairAddress);
    this.dirtyPairs.add(pair.pairAddress.toLowerCase());
  }

  updateReserves(updates: ReserveUpdate[]): void {
    for (const update of updates) {
      const poolIndex = this.poolRegistry.get(update.pairAddress);
      if (poolIndex === undefined) continue;

      const pair = this.pairs[poolIndex];
      if (!pair) continue;

      pair.reserve0 = update.reserve0;
      pair.reserve1 = update.reserve1;
      this.upsertV2Edges(pair, poolIndex);
      this.touch(pair.pairAddress);
      this.dirtyPairs.add(pair.pairAddress.toLowerCase());
    }
  }

  addV3Pool(pool: V3PoolConfig): void {
    if (!pool.enabled) return;

    const poolIndex = this.poolIndex(pool.address);
    const existing = this.v3Pools[poolIndex];
    const poolInfo: V3PoolInfo = {
      ...pool,
      state: existing?.state ?? null,
      ticks: existing?.ticks ?? new Map(),
      bitmapWords: existing?.bitmapWords ?? new Map(),
      fullRange: existing?.fullRange,
    };

    this.v3Pools[poolIndex] = poolInfo;
    this.upsertV3Edges(poolInfo, poolIndex);
    this.touch(pool.address);
    this.dirtyV3.set(pool.address.toLowerCase(), null);
  }

  replaceV3Snapshot(pool: V3PoolConfig, snapshot: V3Snapshot): void {
    if (!snapshot.complete || snapshot.poolAddress.toLowerCase() !== pool.address.toLowerCase()) throw new Error('Cannot publish an incomplete or mismatched V3 snapshot');
    if (!pool.enabled) return;
    this.addV3Pool(pool);
    const poolIndex = this.poolRegistry.get(pool.address);
    if (poolIndex === undefined) return;
    const stored = this.v3Pools[poolIndex]!;
    stored.ticks = new Map(snapshot.ticks.map(tick => [tick.index, { ...tick }]));
    stored.bitmapWords = new Map(snapshot.bitmapWords.map(word => [word.wordPosition, word.bitmap]));
    stored.fullRange = snapshot.complete;
    this.v3TicksCache[poolIndex] = undefined;
    this.updateV3PoolStates([{ poolAddress: pool.address, sqrtPriceX96: snapshot.sqrtPriceX96, tick: snapshot.tick, liquidity: snapshot.liquidity }]);
  }

  invalidateV3Pool(poolAddress: Address): void {
    const pool = this.getV3Pool(poolAddress);
    if (!pool?.state) return;
    this.updateV3PoolStates([{ poolAddress, ...pool.state, liquidity: 0n }]);
    pool.fullRange = false;
  }

  updateV3PoolStates(updates: V3PoolUpdate[]): void {
    for (const update of updates) {
      const poolIndex = this.poolRegistry.get(update.poolAddress);
      if (poolIndex === undefined) continue;

      const pool = this.v3Pools[poolIndex];
      if (!pool) continue;

      pool.state = {
        sqrtPriceX96: update.sqrtPriceX96,
        liquidity: update.liquidity,
        tick: update.tick,
      };
      this.upsertV3Edges(pool, poolIndex);
      this.touchV3(pool.address);
    }
  }

  updateV3Ticks(updates: V3TickUpdate[]): void {
    for (const update of updates) {
      const poolIndex = this.poolRegistry.get(update.poolAddress);
      if (poolIndex === undefined) continue;
      const pool = this.v3Pools[poolIndex];
      if (!pool) continue;

      for (const tick of update.ticks) {
        const compressed = tick.index / pool.tickSpacing;
        const word = Math.floor(compressed / 256);
        const mask = 1n << BigInt(compressed - word * 256);
        const bitmap = pool.bitmapWords.get(word) ?? 0n;
        const next = tick.liquidityGross > 0n ? bitmap | mask : bitmap & ~mask;
        if (next === 0n) pool.bitmapWords.delete(word);
        else pool.bitmapWords.set(word, next);
        if (tick.liquidityGross === 0n && tick.liquidityNet === 0n) {
          pool.ticks.delete(tick.index);
        } else {
          pool.ticks.set(tick.index, tick);
        }
      }
      this.v3TicksCache[poolIndex] = undefined;
      this.touchV3(pool.address, update.ticks);
    }
  }

  rankedEdges(token: Address, limit: number): AnyMarketEdge[] {
    const tokenIndex = this.tokenIndexOf(token);
    if (tokenIndex === undefined) return [];

    return this.rankedEdgeIndexes(tokenIndex, limit)
      .map(edgeIndex => this.edges[edgeIndex].edge);
  }

  setCarbonStrategies(strategies: readonly CarbonStrategy[]): void {
    this.carbonStrategies = strategies;
    this.carbonDirty = true;
    this.touch('$carbon');
    for (const edgeId of this.carbonEdgeIds) {
      const edge = this.edge(edgeId);
      if (edge?.protocol !== 'carbon') continue;
      edge.liquidity = 0n;
      edge.rateNumerator = 0n;
      edge.rateDenominator = 0n;
      if (edge.carbonKind === 'group') edge.orders = [];
    }

    for (const strategy of strategies) {
      this.upsertCarbonEdges(strategy);
    }
    this.upsertGroupedCarbonEdges(strategies);

    this.rankedEdgesCache.clear();
  }

  edgesForTokenPool(token: Address, poolAddress: Address): AnyMarketEdge[] {
    const tokenIndex = this.tokenIndexOf(token);
    const poolIndex = this.poolIndexOf(poolAddress);
    if (tokenIndex === undefined || poolIndex === undefined) return [];

    return this.edgeIndexesForTokenPool(tokenIndex, poolIndex)
      .map(edgeIndex => this.edges[edgeIndex].edge);
  }

  rankedEdgeIndexes(tokenIndex: number, limit: number): number[] {
    if (tokenIndex < 0 || tokenIndex >= this.tokens.length) return [];

    const cached = this.rankedEdgesCache.get(tokenIndex);
    if (cached && cached.limit >= limit) return cached.limit === limit
      ? cached.edgeIndexes
      : cached.edgeIndexes.slice(0, limit);

    const ranked = this.selectTopEdgeIndexes(this.tokens[tokenIndex].edgeIndexes, limit);
    this.rankedEdgesCache.set(tokenIndex, { limit, edgeIndexes: ranked });
    return ranked;
  }

  edgeIndexesForTokenPool(tokenIndex: number, poolIndex: number): number[] {
    if (tokenIndex < 0 || tokenIndex >= this.tokens.length) return [];

    return this.tokens[tokenIndex].pools.get(poolIndex) ?? [];
  }

  tokenIndexOf(token: Address): number | undefined {
    return this.tokenRegistry.get(token);
  }

  poolIndexOf(pool: Address | string): number | undefined {
    return this.poolRegistry.get(pool);
  }

  tokenAddress(tokenIndex: number): Address {
    return this.tokenRegistry.address(tokenIndex) as Address;
  }

  tokenCount(): number {
    return this.tokens.length;
  }

  edgeAt(edgeIndex: number): AnyMarketEdge | null {
    return this.edges[edgeIndex]?.edge ?? null;
  }

  edgeToTokenIndex(edgeIndex: number): number {
    return this.edges[edgeIndex].toTokenIndex;
  }

  edgePoolIndex(edgeIndex: number): number {
    return this.edges[edgeIndex].poolIndex;
  }

  canReachToken(fromTokenIndex: number, targetTokenIndex: number, maxEdges: number): boolean {
    if (fromTokenIndex === targetTokenIndex) return true;
    if (maxEdges <= 0) return false;
    return this.hopDistancesTo(targetTokenIndex)[fromTokenIndex] <= maxEdges;
  }

  edge(edgeId: MarketEdgeId): AnyMarketEdge | null {
    const edgeIndex = this.edgeIndexes.get(edgeId);
    return edgeIndex === undefined ? null : this.edges[edgeIndex].edge;
  }

  quoteEdgeAt(edgeIndex: number, amountIn: bigint): MarketRouteQuote {
    const edge = this.edgeAt(edgeIndex);
    return edge
      ? this.quoteEdge(edge, amountIn)
      : { amountIn, amountOut: 0n, profit: -1n, complete: false };
  }

  carbonExecution(
    edgeIndex: number,
    amountIn: bigint
  ): { rawFrom: Address; rawTo: Address; strategyIds: bigint[]; amounts: bigint[] } | null {
    const edge = this.edgeAt(edgeIndex);
    if (!edge || edge.protocol !== 'carbon') return null;

    if (edge.carbonKind === 'single') {
      return {
        rawFrom: edge.rawFrom,
        rawTo: edge.rawTo,
        strategyIds: [edge.strategyId],
        amounts: [amountIn],
      };
    }

    const allocations: CarbonAllocation[] = [];
    const quote = this.carbonGroupQuoter.quote(edge, amountIn, allocations);
    if (!quote.complete || allocations.length === 0) return null;

    return {
      rawFrom: edge.rawFrom,
      rawTo: edge.rawTo,
      strategyIds: allocations.map(allocation => allocation.strategyId),
      amounts: allocations.map(allocation => allocation.amountIn),
    };
  }

  quote(route: MarketRoute, amountIn: bigint): MarketRouteQuote {
    if (amountIn <= 0n) {
      return { amountIn, amountOut: 0n, profit: 0n, complete: false };
    }

    let amount = amountIn;

    const edgeIndexes = route.edgeIndexes ?? route.edgeIds.map(edgeId => this.edgeIndexes.get(edgeId) ?? -1);

    for (const edgeIndex of edgeIndexes) {
      const edge = this.edgeAt(edgeIndex);
      if (!edge) return { amountIn, amountOut: 0n, profit: -1n, complete: false };

      const quote = this.quoteEdge(edge, amount);

      if (!quote.complete || quote.amountOut <= 0n) {
        return { amountIn, amountOut: quote.amountOut, profit: -1n, complete: false };
      }

      amount = quote.amountOut;
    }

    return {
      amountIn,
      amountOut: amount,
      profit: amount - amountIn,
      complete: true,
    };
  }

  maxInputForRoute(route: MarketRoute): bigint {
    const edgeIndexes = route.edgeIndexes ?? route.edgeIds.map(edgeId => this.edgeIndexes.get(edgeId) ?? -1);
    const first = this.edgeAt(edgeIndexes[0] ?? -1);
    if (!first) return 0n;
    return this.edgeInputCapacity(first) / this.policy.maxInputReserveFraction;
  }

  getPairAddresses(): Address[] {
    return this.pairs.filter((pair): pair is PairInfo => pair !== undefined)
      .map(pair => pair.pairAddress);
  }

  getAllPairs(): PairInfo[] {
    return this.pairs.filter((pair): pair is PairInfo => pair !== undefined);
  }

  getV3PoolAddresses(): Address[] {
    return this.v3Pools.filter((pool): pool is V3PoolInfo => pool !== undefined)
      .map(pool => pool.address);
  }

  getV3Pools(): V3PoolInfo[] {
    return this.v3Pools.filter((pool): pool is V3PoolInfo => pool !== undefined);
  }

  getV3Pool(poolAddress: Address): V3PoolInfo | null {
    const poolIndex = this.poolRegistry.get(poolAddress);
    return poolIndex === undefined ? null : this.v3Pools[poolIndex] ?? null;
  }

  getV3InitializedTicks(poolAddress: Address): V3Tick[] {
    const poolIndex = this.poolRegistry.get(poolAddress);
    if (poolIndex === undefined) return [];
    const pool = this.v3Pools[poolIndex];
    if (!pool) return [];
    return this.v3TicksCache[poolIndex] ??= Array.from(pool.ticks.values())
      .filter(tick => tick.liquidityGross > 0n)
      .sort((a, b) => a.index - b.index);
  }

  findBestFlashPoolForToken(
    token: Address,
    amountIn: bigint,
    excludePools: Address[] = []
  ): FlashPoolCandidate | null {
    const tokenIndex = this.tokenIndexOf(token);
    if (tokenIndex === undefined) return null;

    const excluded = new Set<number>();
    for (const pool of excludePools) {
      const poolIndex = this.poolIndexOf(pool);
      if (poolIndex !== undefined) excluded.add(poolIndex);
    }

    let best: FlashPoolCandidate | null = null;

    for (const edgeIndex of this.flashEdgeIndexes(tokenIndex)) {
      if (excluded.has(this.edges[edgeIndex].poolIndex)) continue;
      const edge = this.edges[edgeIndex].edge;
      if (!protocolPlugin(edge.protocol).flashLoanFee) continue;
      if (edge.protocol === 'v2' && edge.variant !== 'uniswap-v2') continue;
      if (edge.protocol === 'v2' && edge.reserveIn <= amountIn) continue;
      const inputCapacity = this.edgeInputCapacity(edge);
      if (edge.protocol === 'v3' && inputCapacity <= amountIn) continue;

      if (!best || this.flashFee(edge.protocol, edge.fee, amountIn) < this.flashFee(best.protocol, best.fee, amountIn)) {
        best = {
          protocol: edge.protocol,
          poolAddress: edge.poolAddress,
          fee: edge.fee,
          liquidity: inputCapacity,
        };
      }
    }

    return best;
  }

  private quoteV2Edge(edge: Extract<AnyMarketEdge, { protocol: 'v2' }>, amountIn: bigint): MarketRouteQuote {
    if (amountIn >= edge.reserveIn) {
      return { amountIn, amountOut: 0n, profit: -1n, complete: false };
    }

    const amountOut = quoteV2ExactInput(amountIn, edge);
    return {
      amountIn,
      amountOut,
      profit: amountOut - amountIn,
      complete: amountOut > 0n,
    };
  }

  private quoteEdge(edge: AnyMarketEdge, amountIn: bigint): MarketRouteQuote {
    return edge.protocol === 'v2'
      ? this.quoteV2Edge(edge, amountIn)
      : edge.protocol === 'v3'
        ? this.quoteV3Edge(edge, amountIn)
        : this.quoteCarbonEdge(edge, amountIn);
  }

  private quoteV3Edge(edge: Extract<AnyMarketEdge, { protocol: 'v3' }>, amountIn: bigint): MarketRouteQuote {
    const poolIndex = this.poolIndexOf(edge.poolAddress);
    const pool = poolIndex === undefined ? undefined : this.v3Pools[poolIndex];
    if (!pool?.state || pool.state.liquidity <= 0n) {
      return { amountIn, amountOut: 0n, profit: -1n, complete: false };
    }

    let quote: ReturnType<typeof quoteV3MultiRangeExactInput>;
    try {
      quote = quoteV3MultiRangeExactInput({
        amountIn,
        sqrtPriceX96: pool.state.sqrtPriceX96,
        liquidity: pool.state.liquidity,
        tick: pool.state.tick,
        fee: pool.fee,
        direction: edge.direction,
        ticks: this.getV3InitializedTicks(pool.address),
        normalizedTicks: true,
        fullRange: pool.fullRange,
      });
    } catch {
      return { amountIn, amountOut: 0n, profit: -1n, complete: false };
    }

    if (quote.exhaustedLiquidity) {
      return { amountIn, amountOut: quote.amountOut, profit: -1n, complete: false };
    }

    return {
      amountIn,
      amountOut: quote.amountOut,
      profit: quote.amountOut - amountIn,
      complete: quote.amountOut > 0n,
    };
  }

  private upsertV2Edges(pair: PairInfo, poolIndex: number): void {
    if (!protocolAllowed(this.policy, 'v2')) return;

    const token0Index = this.tokenIndex(pair.token0);
    const token1Index = this.tokenIndex(pair.token1);
    const forward = {
      variant: pair.variant,
      reserveIn: pair.reserve0,
      reserveOut: pair.reserve1,
      scaleIn: pair.scale0,
      scaleOut: pair.scale1,
      fee: pair.fee,
    };
    const reverse = {
      variant: pair.variant,
      reserveIn: pair.reserve1,
      reserveOut: pair.reserve0,
      scaleIn: pair.scale1,
      scaleOut: pair.scale0,
      fee: pair.fee,
    };
    const forwardRate = v2MarginalRate(forward);
    const reverseRate = v2MarginalRate(reverse);

    this.upsertEdge({
      id: this.edgeId('v2', poolIndex, 'token0ToToken1'),
      protocol: 'v2',
      from: pair.token0,
      to: pair.token1,
      poolAddress: pair.pairAddress,
      direction: 'token0ToToken1',
      ...forward,
      rateNumerator: forwardRate.numerator,
      rateDenominator: forwardRate.denominator,
      liquidity: pair.reserve0,
    }, token0Index, token1Index, poolIndex);

    this.upsertEdge({
      id: this.edgeId('v2', poolIndex, 'token1ToToken0'),
      protocol: 'v2',
      from: pair.token1,
      to: pair.token0,
      poolAddress: pair.pairAddress,
      direction: 'token1ToToken0',
      ...reverse,
      rateNumerator: reverseRate.numerator,
      rateDenominator: reverseRate.denominator,
      liquidity: pair.reserve1,
    }, token1Index, token0Index, poolIndex);
  }

  private quoteCarbonEdge(edge: CarbonMarketEdge, amountIn: bigint): MarketRouteQuote {
    if (edge.carbonKind === 'group') return this.carbonGroupQuoter.quote(edge, amountIn);

    const quote = quoteCarbonExactInput(amountIn, edge.order, edge.fee);
    return {
      amountIn,
      amountOut: quote.amountOut,
      profit: quote.complete ? quote.amountOut - amountIn : -1n,
      complete: quote.complete,
    };
  }

  private upsertV3Edges(pool: V3PoolInfo, poolIndex: number): void {
    if (!protocolAllowed(this.policy, 'v3')) return;

    const token0Index = this.tokenIndex(pool.token0);
    const token1Index = this.tokenIndex(pool.token1);
    const state = pool.state ?? {
      sqrtPriceX96: 0n,
      liquidity: 0n,
      tick: 0,
    };
    const feeMultiplier = V3_FEE_DENOMINATOR - BigInt(pool.fee);
    const priceNumerator = state.sqrtPriceX96 * state.sqrtPriceX96;

    this.upsertEdge({
      id: this.edgeId('v3', poolIndex, 'token0ToToken1'),
      protocol: 'v3',
      from: pool.token0,
      to: pool.token1,
      poolAddress: pool.address,
      direction: 'token0ToToken1',
      fee: pool.fee,
      sqrtPriceX96: state.sqrtPriceX96,
      tickSpacing: pool.tickSpacing,
      tick: state.tick,
      rateNumerator: priceNumerator * feeMultiplier,
      rateDenominator: Q192 * V3_FEE_DENOMINATOR,
      liquidity: state.liquidity,
    }, token0Index, token1Index, poolIndex);

    this.upsertEdge({
      id: this.edgeId('v3', poolIndex, 'token1ToToken0'),
      protocol: 'v3',
      from: pool.token1,
      to: pool.token0,
      poolAddress: pool.address,
      direction: 'token1ToToken0',
      fee: pool.fee,
      sqrtPriceX96: state.sqrtPriceX96,
      tickSpacing: pool.tickSpacing,
      tick: state.tick,
      rateNumerator: Q192 * feeMultiplier,
      rateDenominator: priceNumerator * V3_FEE_DENOMINATOR,
      liquidity: state.liquidity,
    }, token1Index, token0Index, poolIndex);
  }

  private upsertCarbonEdges(strategy: CarbonStrategy): void {
    if (!protocolAllowed(this.policy, 'carbon')) return;

    this.upsertCarbonOrder(strategy, 0, strategy.token1, strategy.token0);
    this.upsertCarbonOrder(strategy, 1, strategy.token0, strategy.token1);
  }

  private upsertGroupedCarbonEdges(strategies: readonly CarbonStrategy[]): void {
    if (!protocolAllowed(this.policy, 'carbon')) return;

    const groups = new Map<string, {
      controller: Address;
      rawFrom: Address;
      rawTo: Address;
      graphFrom: Address;
      graphTo: Address;
      fee: number;
      direction: SwapDirection;
      orders: Array<CarbonGroupOrder & { rateNumerator: bigint; rateDenominator: bigint; liquidity: bigint }>;
    }>();

    for (const strategy of strategies) {
      this.collectGroupedCarbonOrder(groups, strategy, 0, strategy.token1, strategy.token0);
      this.collectGroupedCarbonOrder(groups, strategy, 1, strategy.token0, strategy.token1);
    }

    for (const group of groups.values()) {
      if (group.orders.length < 2) continue;

      group.orders.sort((a, b) => compareFractions(
        b.rateNumerator,
        b.rateDenominator,
        a.rateNumerator,
        a.rateDenominator
      ));
      const orders = group.orders.slice(0, MAX_GROUPED_CARBON_ORDERS);
      const liquidity = orders.reduce((sum, order) => sum + order.liquidity, 0n);
      if (liquidity <= 0n) continue;

      const poolIndex = this.poolIndex(`carbon-group:${group.controller.toLowerCase()}:${group.rawFrom.toLowerCase()}:${group.rawTo.toLowerCase()}`);
      const tokenIndex = this.tokenIndex(group.graphFrom);
      const toTokenIndex = this.tokenIndex(group.graphTo);
      const edgeId = this.carbonGroupEdgeId(group.controller, group.rawFrom, group.rawTo);
      const best = orders[0];

      this.carbonEdgeIds.add(edgeId);
      this.upsertEdge({
        id: edgeId,
        protocol: 'carbon',
        carbonKind: 'group',
        from: group.graphFrom,
        to: group.graphTo,
        poolAddress: group.controller,
        direction: group.direction,
        fee: group.fee,
        rawFrom: group.rawFrom,
        rawTo: group.rawTo,
        orders,
        rateNumerator: best.rateNumerator,
        rateDenominator: best.rateDenominator,
        liquidity,
      }, tokenIndex, toTokenIndex, poolIndex);
    }
  }

  private collectGroupedCarbonOrder(
    groups: Map<string, {
      controller: Address;
      rawFrom: Address;
      rawTo: Address;
      graphFrom: Address;
      graphTo: Address;
      fee: number;
      direction: SwapDirection;
      orders: Array<CarbonGroupOrder & { rateNumerator: bigint; rateDenominator: bigint; liquidity: bigint }>;
    }>,
    strategy: CarbonStrategy,
    orderIndex: 0 | 1,
    from: Address,
    to: Address
  ): void {
    const order = strategy.orders[orderIndex];
    if (order.y <= 0n || order.z <= 0n) return;

    const rate = carbonMarginalRate(order, strategy.feePpm);
    if (rate.numerator <= 0n || rate.denominator <= 0n) return;

    const key = `${strategy.controller.toLowerCase()}:${from.toLowerCase()}:${to.toLowerCase()}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        controller: strategy.controller,
        rawFrom: from,
        rawTo: to,
        graphFrom: graphToken(from),
        graphTo: graphToken(to),
        fee: strategy.feePpm,
        direction: orderIndex === 0 ? 'token1ToToken0' : 'token0ToToken1',
        orders: [],
      };
      groups.set(key, group);
    }

    group.orders.push({
      strategyId: strategy.id,
      orderIndex,
      rawFrom: from,
      rawTo: to,
      order,
      rateNumerator: rate.numerator,
      rateDenominator: rate.denominator,
      liquidity: order.y,
    });
  }

  private upsertCarbonOrder(
    strategy: CarbonStrategy,
    orderIndex: 0 | 1,
    from: Address,
    to: Address
  ): void {
    const order = strategy.orders[orderIndex];
    if (order.y <= 0n || order.z <= 0n) return;

    const graphFrom = graphToken(from);
    const graphTo = graphToken(to);
    const poolIndex = this.poolIndex(`carbon:${strategy.controller.toLowerCase()}:${strategy.id.toString()}`);
    const tokenIndex = this.tokenIndex(graphFrom);
    const toTokenIndex = this.tokenIndex(graphTo);
    const rate = carbonMarginalRate(order, strategy.feePpm);
    const edgeId = this.carbonEdgeId(strategy, orderIndex);

    this.carbonEdgeIds.add(edgeId);
    this.upsertEdge({
      id: edgeId,
      protocol: 'carbon',
      carbonKind: 'single',
      from: graphFrom,
      to: graphTo,
      poolAddress: strategy.controller,
      direction: orderIndex === 0 ? 'token1ToToken0' : 'token0ToToken1',
      fee: strategy.feePpm,
      strategyId: strategy.id,
      orderIndex,
      rawFrom: from,
      rawTo: to,
      order,
      rateNumerator: rate.numerator,
      rateDenominator: rate.denominator,
      liquidity: order.y,
    }, tokenIndex, toTokenIndex, poolIndex);
  }

  private upsertEdge(
    edge: AnyMarketEdge,
    tokenIndex: number,
    toTokenIndex: number,
    poolIndex: number
  ): void {
    const existingIndex = this.edgeIndexes.get(edge.id);

    if (existingIndex !== undefined) {
      const previousTokenIndex = this.edges[existingIndex].tokenIndex;
      const previousToTokenIndex = this.edges[existingIndex].toTokenIndex;
      const previousPoolIndex = this.edges[existingIndex].poolIndex;
      if (previousTokenIndex !== tokenIndex || previousPoolIndex !== poolIndex) {
        const old = this.tokens[previousTokenIndex].pools.get(previousPoolIndex)!;
        old.splice(old.indexOf(existingIndex), 1);
        const next = this.tokens[tokenIndex].pools.get(poolIndex) ?? [];
        next.push(existingIndex);
        this.tokens[tokenIndex].pools.set(poolIndex, next);
      }
      Object.assign(this.edges[existingIndex].edge, edge);
      this.edges[existingIndex].tokenIndex = tokenIndex;
      this.edges[existingIndex].toTokenIndex = toTokenIndex;
      this.edges[existingIndex].poolIndex = poolIndex;
      this.rankedEdgesCache.delete(previousTokenIndex);
      this.rankedEdgesCache.delete(tokenIndex);
      if (previousToTokenIndex !== toTokenIndex) {
        const incoming = this.tokens[previousToTokenIndex].incomingEdgeIndexes;
        const position = incoming.indexOf(existingIndex);
        if (position >= 0) incoming.splice(position, 1);
        this.tokens[toTokenIndex].incomingEdgeIndexes.push(existingIndex);
        this.hopDistancesCache.clear();
      }
      return;
    }

    const edgeIndex = this.edges.length;
    this.edgeIndexes.set(edge.id, edgeIndex);
    this.edges.push({ edge, tokenIndex, toTokenIndex, poolIndex });
    this.tokens[tokenIndex].edgeIndexes.push(edgeIndex);
    const poolEdges = this.tokens[tokenIndex].pools.get(poolIndex) ?? [];
    poolEdges.push(edgeIndex);
    this.tokens[tokenIndex].pools.set(poolIndex, poolEdges);
    this.tokens[toTokenIndex].incomingEdgeIndexes.push(edgeIndex);
    this.rankedEdgesCache.delete(tokenIndex);
    this.flashEdgesCache.delete(tokenIndex);
    this.hopDistancesCache.clear();
  }

  private selectTopEdgeIndexes(edgeIndexes: number[], limit: number): number[] {
    if (limit <= 0 || edgeIndexes.length === 0) return [];

    const top: number[] = [];
    for (const edgeIndex of edgeIndexes) {
      const edge = this.edges[edgeIndex].edge;
      if (edge.liquidity <= 0n || edge.rateDenominator <= 0n) continue;

      if (top.length < limit) {
        top.push(edgeIndex);
        this.moveEdgeIndexIntoRank(top, top.length - 1);
        continue;
      }

      if (this.compareEdgeRank(edge, this.edges[top[top.length - 1]].edge) < 0) continue;
      top[top.length - 1] = edgeIndex;
      this.moveEdgeIndexIntoRank(top, top.length - 1);
    }

    return top;
  }

  private moveEdgeIndexIntoRank(edgeIndexes: number[], index: number): void {
    while (
      index > 0 &&
      this.compareEdgeRank(this.edges[edgeIndexes[index]].edge, this.edges[edgeIndexes[index - 1]].edge) > 0
    ) {
      const previous = edgeIndexes[index - 1];
      edgeIndexes[index - 1] = edgeIndexes[index];
      edgeIndexes[index] = previous;
      index--;
    }
  }

  private compareEdgeRank(a: AnyMarketEdge, b: AnyMarketEdge): number {
    const aScale = TOKEN_VALUE_SCALE.get(a.to.toLowerCase()) ?? DEFAULT_TOKEN_VALUE_SCALE;
    const bScale = TOKEN_VALUE_SCALE.get(b.to.toLowerCase()) ?? DEFAULT_TOKEN_VALUE_SCALE;
    const rateCompare = compareFractions(
      a.rateNumerator,
      a.rateDenominator * aScale,
      b.rateNumerator,
      b.rateDenominator * bScale
    );

    if (rateCompare !== 0) return rateCompare;
    if (a.liquidity > b.liquidity) return 1;
    if (a.liquidity < b.liquidity) return -1;
    if (a.fee < b.fee) return 1;
    if (a.fee > b.fee) return -1;
    return 0;
  }

  private edgeInputCapacity(edge: AnyMarketEdge): bigint {
    if (edge.protocol === 'v2') return edge.reserveIn;
    if (edge.protocol === 'v3') {
      if (edge.sqrtPriceX96 <= 0n) return 0n;
      return edge.direction === 'token0ToToken1'
        ? (edge.liquidity * Q96) / edge.sqrtPriceX96
        : (edge.liquidity * edge.sqrtPriceX96) / Q96;
    }
    if (edge.carbonKind === 'single') return carbonSourceAmountForFullOrder(edge.order);
    return edge.orders.reduce((total, order) => total + carbonSourceAmountForFullOrder(order.order), 0n);
  }

  private flashFee(protocol: MarketProtocol, fee: number, amount: bigint): bigint {
    return protocolPlugin(protocol).flashLoanFee?.(fee, amount) ?? 0n;
  }

  private flashEdgeIndexes(tokenIndex: number): number[] {
    const cached = this.flashEdgesCache.get(tokenIndex);
    if (cached) return cached;
    const edgeIndexes = this.tokens[tokenIndex].edgeIndexes
      .filter(edgeIndex => {
        const edge = this.edges[edgeIndex].edge;
        return Boolean(protocolPlugin(edge.protocol).flashLoanFee) &&
          (edge.protocol !== 'v2' || edge.variant === 'uniswap-v2');
      })
      .sort((aIndex, bIndex) => {
        const a = this.edges[aIndex].edge;
        const b = this.edges[bIndex].edge;
        const nominal = 10n ** 18n;
        const aFee = this.flashFee(a.protocol, a.fee, nominal);
        const bFee = this.flashFee(b.protocol, b.fee, nominal);
        if (aFee !== bFee) return aFee < bFee ? -1 : 1;
        return a.liquidity > b.liquidity ? -1 : a.liquidity < b.liquidity ? 1 : 0;
      });
    this.flashEdgesCache.set(tokenIndex, edgeIndexes);
    return edgeIndexes;
  }

  private hopDistancesTo(targetTokenIndex: number): Int32Array {
    const cached = this.hopDistancesCache.get(targetTokenIndex);
    if (cached) return cached;
    const distances = new Int32Array(this.tokens.length);
    distances.fill(0x7fffffff);
    distances[targetTokenIndex] = 0;
    const queue = new Int32Array(this.tokens.length);
    let head = 0;
    let tail = 0;
    queue[tail++] = targetTokenIndex;
    while (head < tail) {
      const tokenIndex = queue[head++];
      const distance = distances[tokenIndex] + 1;
      for (const edgeIndex of this.tokens[tokenIndex].incomingEdgeIndexes) {
        const fromTokenIndex = this.edges[edgeIndex].tokenIndex;
        if (distances[fromTokenIndex] <= distance) continue;
        distances[fromTokenIndex] = distance;
        queue[tail++] = fromTokenIndex;
      }
    }
    this.hopDistancesCache.set(targetTokenIndex, distances);
    return distances;
  }

  private edgeId(protocol: 'v2' | 'v3', poolIndex: number, direction: SwapDirection): MarketEdgeId {
    return `${protocol}:${poolIndex}:${direction}`;
  }

  private carbonEdgeId(strategy: CarbonStrategy, orderIndex: 0 | 1): MarketEdgeId {
    return `carbon:${strategy.controller.toLowerCase()}:${strategy.id.toString()}:${orderIndex}`;
  }

  private carbonGroupEdgeId(controller: Address, from: Address, to: Address): MarketEdgeId {
    return `carbon-group:${controller.toLowerCase()}:${from.toLowerCase()}:${to.toLowerCase()}`;
  }

  private tokenIndex(token: Address): number {
    const index = this.tokenRegistry.getOrAdd(token);
    this.tokens[index] ??= { address: token, edgeIndexes: [], incomingEdgeIndexes: [], pools: new Map() };
    return index;
  }

  private poolIndex(pool: Address | string): number {
    return this.poolRegistry.getOrAdd(pool);
  }
}
