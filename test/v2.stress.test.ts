import { describe, expect, test } from "bun:test";
import { type Address } from "viem";
import { TOKENS } from "../src/constants";
import { type PairInfo, type ReserveUpdate } from "../src/protocols/v2/types";
import { type ArbitrageSearchPolicy } from "../src/market-graph/types";
import { OpportunityEngine } from "../src/opportunities/opportunity-engine";
import { LatestUpdateScheduler } from "../src/runtime/event-scheduler";
import { tokenAmount } from "../src/values";

const [tokenA, tokenB, tokenC] = TOKENS.map(({ address }) => address);

const STRESS_PAIR_COUNT = Number(process.env.V2_STRESS_PAIRS ?? 25_000);
const STRESS_SEARCH_LIMIT_MS = Number(process.env.V2_STRESS_SEARCH_LIMIT_MS ?? 1_000);
const STRESS_SCHEDULER_UPDATES = Number(process.env.V2_STRESS_UPDATES ?? 50_000);

const stressPolicy: ArbitrageSearchPolicy = {
  topTokens: 1,
  allowedProtocols: ["v2", "v3"],
  allowProtocolMixing: true,
  maxRouteEdges: 4,
  beamWidth: 8,
  optimizationIterations: 80,
  maxInputReserveFraction: 3n,
  maxOpportunities: 10,
};

function pairAddress(id: number): Address {
  return `0x${id.toString(16).padStart(40, "0")}` as Address;
}

function tokenAddress(id: number): Address {
  return `0x${(10_000_000 + id).toString(16).padStart(40, "0")}` as Address;
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

function reserveUpdate(pairInfo: PairInfo, reserve0: bigint, reserve1: bigint): ReserveUpdate {
  return {
    pairAddress: pairInfo.pairAddress,
    reserve0,
    reserve1,
  };
}

function createLargeMarket(pairCount: number): {
  engine: OpportunityEngine;
  changedPair: PairInfo;
} {
  const engine = new OpportunityEngine(stressPolicy);

  for (let i = 0; i < pairCount; i++) {
    engine.graph.addPair(pair(
      10_000 + i,
      tokenA,
      tokenAddress(i),
      tokenAmount("1000000"),
      tokenAmount("999000"),
    ));
  }

  const changedPair = pair(1, tokenA, tokenB, tokenAmount("1000"), tokenAmount("1100"));
  engine.graph.addPair(changedPair);
  engine.graph.addPair(pair(2, tokenB, tokenC, tokenAmount("1000"), tokenAmount("2200")));
  engine.graph.addPair(pair(3, tokenC, tokenA, tokenAmount("1000"), tokenAmount("2200")));

  return { engine, changedPair };
}

describe("V2 arbitrage stress", () => {
  test("event-local scan stays bounded with many unrelated pairs", () => {
    const { engine, changedPair } = createLargeMarket(STRESS_PAIR_COUNT);

    const startedAt = performance.now();
    const opportunities = engine.findOpportunities({
      startTokens: [tokenA],
      changedPairs: [changedPair.pairAddress],
    });
    const elapsedMs = performance.now() - startedAt;

    expect(opportunities.length).toBeGreaterThan(0);
    expect(opportunities[0].pairs).toContain(changedPair.pairAddress);
    expect(elapsedMs).toBeLessThan(STRESS_SEARCH_LIMIT_MS);
  });

  test("reserve update plus local scan handles a large graph without full opportunity rescans", () => {
    const { engine, changedPair } = createLargeMarket(STRESS_PAIR_COUNT);

    const startedAt = performance.now();
    engine.graph.updateReserves([
      reserveUpdate(changedPair, tokenAmount("1000"), tokenAmount("1200")),
    ]);
    const opportunities = engine.findOpportunities({
      startTokens: [tokenA],
      changedPairs: [changedPair.pairAddress],
    });
    const elapsedMs = performance.now() - startedAt;

    expect(opportunities.length).toBeGreaterThan(0);
    expect(opportunities[0].pairs).toContain(changedPair.pairAddress);
    expect(elapsedMs).toBeLessThan(STRESS_SEARCH_LIMIT_MS);
  });

  test("scheduler collapses a large update burst to latest reserve per pair", async () => {
    const pairCount = 100;
    const processed: ReserveUpdate[][] = [];
    const scheduler = new LatestUpdateScheduler<ReserveUpdate>(async updates => {
      processed.push(updates);
    }, update => update.pairAddress.toLowerCase());

    const burst: ReserveUpdate[] = [];
    for (let i = 0; i < STRESS_SCHEDULER_UPDATES; i++) {
      const pairId = i % pairCount;
      burst.push({
        pairAddress: pairAddress(pairId),
        reserve0: BigInt(i),
        reserve1: BigInt(i + 1),
      });
    }

    await scheduler.submit(burst);

    expect(processed).toHaveLength(1);
    expect(processed[0]).toHaveLength(pairCount);
    for (const update of processed[0]) {
      expect(update.reserve1).toBe(update.reserve0 + 1n);
    }
  });
});
