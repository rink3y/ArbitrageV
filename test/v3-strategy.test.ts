import { describe, expect, test } from "bun:test";
import { type Address } from "viem";
import { TOKENS } from "../src/constants";
import { type V3PoolConfig } from "../src/protocols/v3/types";
import { MarketGraph } from "../src/market-graph/market-graph";
import { type ArbitrageSearchPolicy } from "../src/market-graph/types";
import { OpportunityEngine } from "../src/opportunities/opportunity-engine";
import { Q96 } from "../src/protocols/v3/quote";
import { type PairInfo } from "../src/protocols/v2/types";
import { tokenAmount } from "../src/values";

const [tokenA, tokenB, tokenC] = TOKENS.map(({ address }) => address);

const policy: ArbitrageSearchPolicy = {
  topTokens: 1,
  allowedProtocols: ["v2", "v3"],
  allowProtocolMixing: true,
  maxRouteEdges: 3,
  beamWidth: 5,
  optimizationIterations: 40,
  maxInputReserveFraction: 100n,
  maxOpportunities: 5,
};

function poolAddress(id: number): Address {
  return `0x${(9_000_000 + id).toString(16).padStart(40, "0")}` as Address;
}

function pairAddress(id: number): Address {
  return `0x${(8_000_000 + id).toString(16).padStart(40, "0")}` as Address;
}

function pair(
  id: number,
  token0: Address,
  token1: Address,
  reserve0: bigint,
  reserve1: bigint,
  fee = 30,
): PairInfo {
  return {
    pairAddress: pairAddress(id),
    token0,
    token1,
    reserve0,
    reserve1,
    fee,
    variant: 'uniswap-v2',
    scale0: 1n,
    scale1: 1n,
  };
}

function pool(id: number, token0: Address, token1: Address, fee = 500): V3PoolConfig {
  return {
    name: `v3-strategy-${id}`,
    address: poolAddress(id),
    token0,
    token1,
    fee,
    tickSpacing: 10,
    enabled: true,
  };
}

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
    const graph = new MarketGraph(policy, []);
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
    const engine = new OpportunityEngine(policy, []);
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
    expect(opportunities[0].profit).toBeGreaterThan(TOKENS[0].minProfit);
    expect(opportunities[0].optimalInput).toBeGreaterThan(0n);
  });

  test("finds a mixed V2 to V3 to V2 circular opportunity", () => {
    const engine = new OpportunityEngine(policy, []);
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
    expect(opportunities[0].profit).toBeGreaterThan(TOKENS[0].minProfit);
    expect(opportunities[0].optimalInput).toBeGreaterThan(0n);
  });

  test("blocks mixed routes when protocol mixing is disabled", () => {
    const engine = new OpportunityEngine({
      ...policy,
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
    const engine = new OpportunityEngine(policy, []);
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
