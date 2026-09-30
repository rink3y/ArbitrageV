import { describe, expect, test } from "bun:test";
import { type Address } from "viem";
import { ARBITRAGE_SEARCH_POLICY } from "../src/constants";
import { routeTokens, v2Pair as pair } from './helpers/markets';
import { type ArbitrageSearchPolicy } from '../src/market-graph/types';
import { OpportunityEngine } from '../src/opportunities/opportunity-engine';
import { Q96 } from '../src/protocols/v3/quote';
import { tokenAmount } from '../src/values';
import { type V3PoolConfig } from "../src/protocols/v3/types";
import { MarketGraph } from "../src/market-graph/market-graph";
import { tickWordBounds } from '../src/protocols/v3/coverage';
import { type V3Snapshot } from '../src/protocols/v3/types';

const [tokenA, tokenB, tokenC] = routeTokens.map(({ address }) => address);
const policy = { ...ARBITRAGE_SEARCH_POLICY, allowedProtocols: ['v2', 'v3', 'carbon'] as const };

function poolAddress(id: number): Address {
  return `0x${(5_000_000 + id).toString(16).padStart(40, "0")}` as Address;
}

function pool(
  id: number,
  token0: Address,
  token1: Address,
  fee = 500,
  enabled = true,
): V3PoolConfig {
  return {
    name: `v3-pool-${id}`,
    address: poolAddress(id),
    token0,
    token1,
    fee,
    tickSpacing: fee === 500 ? 10 : 60,
    enabled,
  };
}

describe("MarketGraph V3 pools", () => {
  test('snapshot replacement removes stale ticks and rejects partial publication', () => {
    const selected = pool(1, tokenA, tokenB, 3000);
    const graph = new MarketGraph(policy, [selected]);
    const snapshot: V3Snapshot = {
      poolAddress: selected.address, sqrtPriceX96: 2n ** 96n, tick: 0, liquidity: 1000n,
      blockNumber: 10n, blockHash: `0x${'0'.repeat(64)}`, complete: true,
      ...tickWordBounds(selected.tickSpacing), bitmapWords: [{ wordPosition: -1, bitmap: 1n << 255n }],
      ticks: [{ index: -60, liquidityGross: 1000n, liquidityNet: 1000n }],
    };
    graph.replaceV3Snapshot(selected, snapshot);
    expect(graph.getV3Pool(selected.address)?.fullRange).toBe(true);
    expect(graph.getV3Pool(selected.address)?.bitmapWords.get(-1)).toBe(1n << 255n);
    expect(() => graph.replaceV3Snapshot(selected, { ...snapshot, complete: false })).toThrow('incomplete');
    graph.replaceV3Snapshot(selected, { ...snapshot, bitmapWords: [], ticks: [], liquidity: 0n });
    expect(graph.getV3Pool(selected.address)?.bitmapWords.size).toBe(0);
    expect(graph.getV3InitializedTicks(selected.address)).toEqual([]);
    graph.replaceV3Snapshot(selected, snapshot);
    graph.invalidateV3Pool(selected.address);
    expect(graph.rankedEdges(tokenA, 10)).toEqual([]);
    expect(graph.getV3Pool(selected.address)?.fullRange).toBe(false);
  });

  test("loads only explicitly configured enabled pools", () => {
    const enabledPool = pool(1, tokenA, tokenB, 3000);
    const disabledPool = pool(2, tokenA, tokenC, 500, false);
    const graph = new MarketGraph(policy, [enabledPool, disabledPool]);

    expect(graph.getV3PoolAddresses()).toEqual([enabledPool.address]);
    expect(graph.getV3Pools().some(pool => pool.address === disabledPool.address)).toBe(false);
  });

  test("updates configured pool state and exposes directional edges", () => {
    const configuredPool = pool(1, tokenA, tokenB, 3000);
    const graph = new MarketGraph(policy, [configuredPool]);

    graph.updateV3PoolStates([{
      poolAddress: configuredPool.address,
      sqrtPriceX96: 2n ** 96n,
      liquidity: 1_000_000n,
      tick: 0,
    }]);

    const token0Edge = graph.edgesForTokenPool(tokenA, configuredPool.address)[0];
    const token1Edge = graph.edgesForTokenPool(tokenB, configuredPool.address)[0];

    expect(token0Edge?.protocol).toBe("v3");
    expect(token0Edge?.direction).toBe("token0ToToken1");
    expect(token0Edge?.to).toBe(tokenB);
    expect(token0Edge?.protocol === "v3" ? token0Edge.sqrtPriceX96 : 0n).toBe(2n ** 96n);
    expect(token0Edge?.liquidity).toBe(1_000_000n);
    expect(token1Edge?.protocol).toBe("v3");
    expect(token1Edge?.direction).toBe("token1ToToken0");
    expect(token1Edge?.to).toBe(tokenA);
    expect(token1Edge?.protocol === "v3" ? token1Edge.sqrtPriceX96 : 0n).toBe(2n ** 96n);
  });

  test("ranks only pools with live liquidity", () => {
    const lowLiquidityPool = pool(1, tokenA, tokenB, 3000);
    const noStatePool = pool(2, tokenA, tokenC, 500);
    const highLiquidityPool = pool(3, tokenA, tokenC, 500);
    const graph = new MarketGraph(policy, [lowLiquidityPool, noStatePool, highLiquidityPool]);

    graph.updateV3PoolStates([
      {
        poolAddress: lowLiquidityPool.address,
        sqrtPriceX96: 2n ** 96n,
        liquidity: 100n,
        tick: 0,
      },
      {
        poolAddress: highLiquidityPool.address,
        sqrtPriceX96: 2n ** 96n,
        liquidity: 1_000n,
        tick: 0,
      },
    ]);

    const ranked = graph.rankedEdges(tokenA, 10);

    expect(ranked.map(edge => edge.poolAddress)).toEqual([
      highLiquidityPool.address,
      lowLiquidityPool.address,
    ]);
    expect(ranked.every(edge => edge.liquidity > 0n)).toBe(true);
  });

  test("updates initialized ticks and removes empty ticks", () => {
    const configuredPool = pool(1, tokenA, tokenB, 3000);
    const graph = new MarketGraph(policy, [configuredPool]);

    graph.updateV3Ticks([{
      poolAddress: configuredPool.address,
      ticks: [
        { index: -120, liquidityGross: 1_000n, liquidityNet: 1_000n },
        { index: 120, liquidityGross: 1_000n, liquidityNet: -1_000n },
      ],
    }]);

    expect(graph.getV3InitializedTicks(configuredPool.address).map(tick => tick.index)).toEqual([-120, 120]);

    graph.updateV3Ticks([{
      poolAddress: configuredPool.address,
      ticks: [
        { index: -120, liquidityGross: 0n, liquidityNet: 0n },
      ],
    }]);

    expect(graph.getV3InitializedTicks(configuredPool.address).map(tick => tick.index)).toEqual([120]);
  });

});

const searchPolicy: ArbitrageSearchPolicy = {
  topTokens: 1,
  allowedProtocols: ["v2", "v3"],
  allowProtocolMixing: true,
  maxRouteEdges: 3,
  beamWidth: 5,
  optimizationIterations: 40,
  maxInputReserveFraction: 100n,
  maxOpportunities: 5,
};

function addLivePool(
  target: MarketGraph,
  config: V3PoolConfig,
  sqrtPriceX96 = Q96 * 2n,
  liquidity = 10n ** 24n,
): void {
  target.addV3Pool(config);
  target.updateV3PoolStates([{
    poolAddress: config.address,
    sqrtPriceX96,
    liquidity,
    tick: 0,
  }]);
}

describe("V3 arbitrage strategy", () => {
  test("marks a route quote incomplete when it runs beyond loaded tick data", () => {
    const graph = new MarketGraph(searchPolicy, []);
    const configuredPool = pool(1, tokenA, tokenB);
    addLivePool(graph, configuredPool, Q96, 1_000n);
    const edge = graph.rankedEdges(tokenA, 1)[0];

    const quote = graph.quote({
      path: [tokenA, tokenB],
      pools: [configuredPool.address],
      edgeIds: [edge.id],
      protocols: ["v3"],
    }, 10n ** 30n);

    expect(quote.complete).toBe(false);
  });

  test("finds a complete profitable V3 circular opportunity", () => {
    const engine = new OpportunityEngine(searchPolicy, []);
    const poolAB = pool(1, tokenA, tokenB);
    const poolBC = pool(2, tokenB, tokenC);
    const poolCA = pool(3, tokenC, tokenA);

    addLivePool(engine.graph, poolAB);
    addLivePool(engine.graph, poolBC);
    addLivePool(engine.graph, poolCA);

    const opportunities = engine.findOpportunities({
      startTokens: [tokenA],
    });

    expect(opportunities.length).toBeGreaterThan(0);
    expect(opportunities[0].protocols).toEqual(["v3", "v3", "v3"]);
    expect(opportunities[0].path).toEqual([tokenA, tokenB, tokenC, tokenA]);
    expect(opportunities[0].pairs).toEqual([poolAB.address, poolBC.address, poolCA.address]);
    expect(opportunities[0].profit).toBeGreaterThan(routeTokens[0].minProfitNative ?? 0n);
    expect(opportunities[0].optimalInput).toBeGreaterThan(0n);
  });

  test("finds a mixed V2 to V3 to V2 circular opportunity", () => {
    const engine = new OpportunityEngine(searchPolicy, []);
    const pairAB = pair(1, tokenA, tokenB, tokenAmount("1000"), tokenAmount("2200"));
    const pairCA = pair(2, tokenC, tokenA, tokenAmount("1000"), tokenAmount("2200"));
    engine.graph.addPair(pairAB);
    engine.graph.addPair(pairCA);

    const poolBC = pool(1, tokenB, tokenC);
    addLivePool(engine.graph, poolBC);

    const opportunities = engine.findOpportunities({
      startTokens: [tokenA],
    });

    expect(opportunities.length).toBeGreaterThan(0);
    expect(new Set(opportunities[0].protocols).size).toBeGreaterThan(1);
    expect(opportunities[0].path).toEqual([tokenA, tokenB, tokenC, tokenA]);
    expect(opportunities[0].pairs).toEqual([pairAB.pairAddress, poolBC.address, pairCA.pairAddress]);
    expect(opportunities[0].profit).toBeGreaterThan(routeTokens[0].minProfitNative ?? 0n);
    expect(opportunities[0].optimalInput).toBeGreaterThan(0n);
  });

  test("blocks mixed routes when protocol mixing is disabled", () => {
    const engine = new OpportunityEngine({
      ...searchPolicy,
      allowProtocolMixing: false,
    }, []);
    engine.graph.addPair(pair(1, tokenA, tokenB, tokenAmount("1000"), tokenAmount("2200")));
    engine.graph.addPair(pair(2, tokenC, tokenA, tokenAmount("1000"), tokenAmount("2200")));
    addLivePool(engine.graph, pool(1, tokenB, tokenC));

    const opportunities = engine.findOpportunities({
      startTokens: [tokenA],
    });

    expect(opportunities).toEqual([]);
  });

  test("selects the best non-route flash pool across V2 and V3", () => {
    const engine = new OpportunityEngine(searchPolicy, []);
    const routePair = pair(1, tokenA, tokenB, tokenAmount("1000"), tokenAmount("2200"));
    const fallbackPair = pair(2, tokenA, tokenC, tokenAmount("10000"), tokenAmount("10000"));
    engine.graph.addPair(routePair);
    engine.graph.addPair(fallbackPair);

    const v3FlashPool = pool(3, tokenA, tokenC);
    addLivePool(engine.graph, v3FlashPool, Q96, 10n ** 24n);

    const flashPool = engine.graph.findBestFlashPoolForToken(tokenA, 1_000n, [routePair.pairAddress]);

    expect(flashPool?.protocol).toBe("v3");
    expect(flashPool?.poolAddress).toBe(v3FlashPool.address);
  });
});
