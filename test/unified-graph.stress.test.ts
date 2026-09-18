import { describe, expect, test } from "bun:test";
import { type Address } from "viem";
import { TOKENS } from "../src/constants";
import { type PairInfo } from "../src/protocols/v2/types";
import { type V3PoolConfig } from "../src/protocols/v3/types";
import { type ArbitrageSearchPolicy } from "../src/market-graph/types";
import { OpportunityEngine } from "../src/opportunities/opportunity-engine";
import { Q96 } from "../src/protocols/v3/quote";
import { tokenAmount } from "../src/values";

const [tokenA, tokenB, tokenC] = TOKENS.map(({ address }) => address);

const UNIFIED_V2_DISTRACTORS = Number(15_000);
const UNIFIED_V3_DISTRACTORS = Number(5_000);
const UNIFIED_SEARCH_LIMIT_MS = Number(1_250);

const stressPolicy: ArbitrageSearchPolicy = {
  topTokens: 1,
  allowedProtocols: ["v2", "v3"],
  allowProtocolMixing: true,
  maxRouteEdges: 4,
  beamWidth: 8,
  optimizationIterations: 80,
  maxInputReserveFraction: 100n,
  maxOpportunities: 8,
};

function tokenAddress(id: number): Address {
  return `0x${(30_000_000 + id).toString(16).padStart(40, "0")}` as Address;
}

function pairAddress(id: number): Address {
  return `0x${(40_000_000 + id).toString(16).padStart(40, "0")}` as Address;
}

function poolAddress(id: number): Address {
  return `0x${(50_000_000 + id).toString(16).padStart(40, "0")}` as Address;
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
    name: `unified-stress-${id}`,
    address: poolAddress(id),
    token0,
    token1,
    fee,
    tickSpacing: 10,
    enabled: true,
  };
}

function addLivePool(
  engine: OpportunityEngine,
  config: V3PoolConfig,
  sqrtPriceX96 = Q96,
  liquidity = 10n ** 24n,
): void {
  engine.graph.addV3Pool(config);
  engine.graph.updateV3PoolStates([{
    poolAddress: config.address,
    sqrtPriceX96,
    liquidity,
    tick: 0,
  }]);
}

function createUnifiedStressMarket(): {
  engine: OpportunityEngine;
  changedPair: PairInfo;
  mixedPool: V3PoolConfig;
} {
  const engine = new OpportunityEngine(stressPolicy, []);

  for (let i = 0; i < UNIFIED_V2_DISTRACTORS; i++) {
    engine.graph.addPair(pair(
      10_000 + i,
      tokenA,
      tokenAddress(i),
      tokenAmount("1000000"),
      tokenAmount("999000"),
    ));
  }

  for (let i = 0; i < UNIFIED_V3_DISTRACTORS; i++) {
    addLivePool(engine, pool(
      20_000 + i,
      tokenA,
      tokenAddress(UNIFIED_V2_DISTRACTORS + i),
    ), Q96, 10n ** 18n);
  }

  const changedPair = pair(1, tokenA, tokenB, tokenAmount("1000"), tokenAmount("2200"));
  const closingPair = pair(2, tokenC, tokenA, tokenAmount("1000"), tokenAmount("2200"));
  const mixedPool = pool(1, tokenB, tokenC);

  engine.graph.addPair(changedPair);
  engine.graph.addPair(closingPair);
  addLivePool(engine, mixedPool, Q96 * 2n, 10n ** 24n);

  return {
    engine,
    changedPair,
    mixedPool,
  };
}

describe("Unified graph stress", () => {
  test("finds a profitable mixed route with many V2 and V3 distractors", () => {
    const { engine, changedPair, mixedPool } = createUnifiedStressMarket();

    const startedAt = performance.now();
    const opportunities = engine.findOpportunities({
      startTokens: [tokenA],
      changedPairs: [changedPair.pairAddress],
    });
    const elapsedMs = performance.now() - startedAt;

    expect(opportunities.length).toBeGreaterThan(0);
    expect(new Set(opportunities[0].protocols).size).toBeGreaterThan(1);
    expect(opportunities[0].pairs).toContain(changedPair.pairAddress);
    expect(opportunities[0].pairs).toContain(mixedPool.address);
    expect(typeof opportunities[0].profit).toBe("bigint");
    expect(typeof opportunities[0].optimalInput).toBe("bigint");
    expect(elapsedMs).toBeLessThan(UNIFIED_SEARCH_LIMIT_MS);
  });

  test("event-local update scan stays bounded on the unified graph", () => {
    const { engine, changedPair } = createUnifiedStressMarket();

    const startedAt = performance.now();
    engine.graph.updateReserves([{
      pairAddress: changedPair.pairAddress,
      reserve0: tokenAmount("1000"),
      reserve1: tokenAmount("2500"),
    }]);
    const opportunities = engine.findOpportunities({
      startTokens: [tokenA],
      changedPairs: [changedPair.pairAddress],
    });
    const elapsedMs = performance.now() - startedAt;

    expect(opportunities.length).toBeGreaterThan(0);
    for (const routePools of opportunities.map(opportunity => opportunity.pairs)) {
      expect(routePools).toContain(changedPair.pairAddress);
    }
    expect(elapsedMs).toBeLessThan(UNIFIED_SEARCH_LIMIT_MS);
  });

  test("protocol mixing policy blocks mixed opportunities under load", () => {
    const { changedPair, mixedPool } = createUnifiedStressMarket();
    const engine = new OpportunityEngine({
      ...stressPolicy,
      allowProtocolMixing: false,
    }, []);
    engine.graph.addPair(changedPair);
    engine.graph.addPair(pair(2, tokenC, tokenA, tokenAmount("1000"), tokenAmount("2200")));
    addLivePool(engine, mixedPool, Q96 * 2n, 10n ** 24n);

    const opportunities = engine.findOpportunities({
      startTokens: [tokenA],
      changedPairs: [changedPair.pairAddress],
    });

    expect(opportunities).toEqual([]);
  });
});
