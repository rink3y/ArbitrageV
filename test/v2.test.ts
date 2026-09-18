import { describe, expect, test } from "bun:test";
import { type Address } from "viem";
import { TOKENS } from "../src/constants";
import { swapSolidlyStable, swapV2 } from "../src/protocols/v2/quote";
import { encodeV2RouteData } from "../src/protocols/v2/execution";
import { type PairInfo } from "../src/protocols/v2/types";
import { type ArbitrageSearchPolicy } from "../src/market-graph/types";
import { OpportunityEngine } from "../src/opportunities/opportunity-engine";
import { tokenAmount } from "../src/values";

const [tokenA, tokenB, tokenC] = TOKENS.map(({ address }) => address);

function pairAddress(id: number): Address {
  return `0x${id.toString(16).padStart(40, "0")}` as Address;
}

function tokenAddress(id: number): Address {
  return `0x${(100000 + id).toString(16).padStart(40, "0")}` as Address;
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

function buildGraph(pairs: PairInfo[]): OpportunityEngine {
  const graph = new OpportunityEngine();
  for (const pool of pairs) {
    graph.graph.addPair(pool);
  }
  return graph;
}

test("swapV2 matches the Solidity formula without early rounding", () => {
  expect(swapV2(
    539925606765789908n,
    3985615020080708851788n,
    192800406359137571957073064n,
    30,
  )).toBe(26036525510536776183643n);
});

test("stable V2 quote matches the historical Yaka pool output", () => {
  expect(swapSolidlyStable(12_271_683n, {
    variant: 'solidly-stable',
    reserveIn: 21_501_234n,
    reserveOut: 149_089_569n,
    scaleIn: 1_000_000n,
    scaleOut: 1_000_000n,
    fee: 4,
  })).toBe(22_886_491n);
  expect(encodeV2RouteData('solidly-stable')).toBe('0x01');
  expect(encodeV2RouteData('solidly-volatile')).toBe('0x');
});

describe("V2 arbitrage graph", () => {
  test("keeps stable pools in routes and marks their execution mode", () => {
    const stable = pair(1, tokenA, tokenB, tokenAmount("1000"), tokenAmount("2200"), 4);
    stable.variant = 'solidly-stable';
    stable.scale0 = 10n ** 18n;
    stable.scale1 = 10n ** 18n;
    const graph = buildGraph([
      stable,
      pair(2, tokenB, tokenC, tokenAmount("1000"), tokenAmount("2200")),
      pair(3, tokenC, tokenA, tokenAmount("1000"), tokenAmount("2200")),
    ]);

    const opportunity = graph.findOpportunities({ startTokens: [tokenA] })[0];
    expect(opportunity.routeData).toEqual(['0x01', '0x', '0x']);
    expect(graph.graph.findBestFlashPoolForToken(tokenA, 1n, [pairAddress(2), pairAddress(3)])).toBeNull();
  });

  test("finds a profitable three-pool circular arbitrage route", () => {
    const graph = buildGraph([
      pair(1, tokenA, tokenB, tokenAmount("1000"), tokenAmount("2200")),
      pair(2, tokenB, tokenC, tokenAmount("1000"), tokenAmount("2200")),
      pair(3, tokenC, tokenA, tokenAmount("1000"), tokenAmount("2200")),
    ]);

    const opportunities = graph.findOpportunities({
      startTokens: [tokenA],
    });

    expect(opportunities.length).toBeGreaterThan(0);
    expect(opportunities[0].path).toEqual([tokenA, tokenB, tokenC, tokenA]);
    expect(opportunities[0].pairs).toHaveLength(3);
    expect(new Set(opportunities[0].pairs).size).toBe(3);
    expect(opportunities[0].optimalInput).toBeGreaterThan(0n);
    expect(opportunities[0].profit).toBeGreaterThan(TOKENS[0].minProfit);
  });

  test("does not report a route when fees make the cycle unprofitable", () => {
    const graph = buildGraph([
      pair(1, tokenA, tokenB, tokenAmount("1000"), tokenAmount("1000")),
      pair(2, tokenB, tokenC, tokenAmount("1000"), tokenAmount("1000")),
      pair(3, tokenC, tokenA, tokenAmount("1000"), tokenAmount("1000")),
    ]);

    const opportunities = graph.findOpportunities({
      startTokens: [tokenA],
    });

    expect(opportunities).toEqual([]);
    expect(opportunities.map(opportunity => opportunity.profit)).toEqual([]);
    expect(opportunities.map(opportunity => opportunity.optimalInput)).toEqual([]);
  });

  test("does not reuse the same pair to manufacture a false two-hop cycle", () => {
    const graph = buildGraph([
      pair(1, tokenA, tokenB, tokenAmount("1000"), tokenAmount("5000")),
    ]);

    const opportunities = graph.findOpportunities({
      startTokens: [tokenA],
    });

    expect(opportunities).toEqual([]);
  });

  test("keeps bigint precision for a tiny but real reserve imbalance", () => {
    const graph = buildGraph([
      pair(1, tokenA, tokenB, tokenAmount("1000000"), tokenAmount("1003000"), 1),
      pair(2, tokenB, tokenC, tokenAmount("1000000"), tokenAmount("1003000"), 1),
      pair(3, tokenC, tokenA, tokenAmount("1000000"), tokenAmount("1003000"), 1),
    ]);

    const opportunities = graph.findOpportunities({
      startTokens: [tokenA],
    });

    expect(opportunities.length).toBeGreaterThan(0);
    expect(opportunities[0].profit).toBeGreaterThan(TOKENS[0].minProfit);
  });

  test("keeps bigint precision with reserves larger than Number safe integer range", () => {
    const hugeReserve = 10n ** 40n;
    const graph = buildGraph([
      pair(1, tokenA, tokenB, hugeReserve, hugeReserve * 2n, 1),
      pair(2, tokenB, tokenC, hugeReserve, hugeReserve * 2n, 1),
      pair(3, tokenC, tokenA, hugeReserve, hugeReserve * 2n, 1),
    ]);

    const opportunities = graph.findOpportunities({
      startTokens: [tokenA],
    });

    expect(opportunities.length).toBeGreaterThan(0);
    expect(opportunities[0].profit).toBeGreaterThan(TOKENS[0].minProfit);
    expect(opportunities[0].optimalInput).toBeGreaterThan(9007199254740991n);
    expect(typeof opportunities[0].profit).toBe("bigint");
    expect(typeof opportunities[0].optimalInput).toBe("bigint");
  });

  test("keeps the profitable route visible with many irrelevant outgoing pairs", () => {
    const distractors: PairInfo[] = [];
    for (let i = 0; i < 500; i++) {
      distractors.push(
        pair(
          1000 + i,
          tokenA,
          tokenAddress(i),
          tokenAmount("1000000"),
          tokenAmount("999000"),
        )
      );
    }

    const graph = buildGraph([
      ...distractors,
      pair(1, tokenA, tokenB, tokenAmount("1000"), tokenAmount("2200")),
      pair(2, tokenB, tokenC, tokenAmount("1000"), tokenAmount("2200")),
      pair(3, tokenC, tokenA, tokenAmount("1000"), tokenAmount("2200")),
    ]);

    const opportunities = graph.findOpportunities({
      startTokens: [tokenA],
    });

    expect(opportunities.length).toBeGreaterThan(0);
    expect(opportunities[0].path).toEqual([tokenA, tokenB, tokenC, tokenA]);
  });

  test("event-local search only returns routes touching affected pairs", () => {
    const changedPair = pair(1, tokenA, tokenB, tokenAmount("1000"), tokenAmount("2200"));
    const graph = buildGraph([
      changedPair,
      pair(2, tokenB, tokenC, tokenAmount("1000"), tokenAmount("2200")),
      pair(3, tokenC, tokenA, tokenAmount("1000"), tokenAmount("2200")),
      pair(4, tokenA, tokenB, tokenAmount("1000"), tokenAmount("3000")),
      pair(5, tokenB, tokenC, tokenAmount("1000"), tokenAmount("3000")),
      pair(6, tokenC, tokenA, tokenAmount("1000"), tokenAmount("3000")),
    ]);

    const opportunities = graph.findOpportunities({
      startTokens: [tokenA],
      changedPairs: [changedPair.pairAddress],
    });

    expect(opportunities.length).toBeGreaterThan(0);
    for (const routePairs of opportunities.map(opportunity => opportunity.pairs)) {
      expect(routePairs).toContain(changedPair.pairAddress);
    }
  });

  test("event-local search keeps an affected pair even when it is outside the normal beam", () => {
    const distractors: PairInfo[] = [];
    for (let i = 0; i < 20; i++) {
      distractors.push(
        pair(
          2000 + i,
          tokenA,
          tokenAddress(1000 + i),
          tokenAmount("1000"),
          tokenAmount("5000"),
        )
      );
    }

    const changedPair = pair(1, tokenA, tokenB, tokenAmount("1000"), tokenAmount("1100"));
    const graph = buildGraph([
      ...distractors,
      changedPair,
      pair(2, tokenB, tokenC, tokenAmount("1000"), tokenAmount("2200")),
      pair(3, tokenC, tokenA, tokenAmount("1000"), tokenAmount("2200")),
    ]);

    const opportunities = graph.findOpportunities({
      startTokens: [tokenA],
      changedPairs: [changedPair.pairAddress],
    });

    expect(opportunities.length).toBeGreaterThan(0);
    for (const routePairs of opportunities.map(opportunity => opportunity.pairs)) {
      expect(routePairs).toContain(changedPair.pairAddress);
    }
  });

  test("keeps beam states separate for different start tokens", () => {
    const tokenD = tokenAddress(9_999);
    const policy: ArbitrageSearchPolicy = {
      topTokens: 2,
      allowedProtocols: ["v2"],
      allowProtocolMixing: true,
      maxRouteEdges: 3,
      beamWidth: 1,
      optimizationIterations: 16,
      maxInputReserveFraction: 10n,
      maxOpportunities: 5,
    };
    const graph = new OpportunityEngine(policy, []);
    for (const pool of [
      pair(10, tokenA, tokenC, tokenAmount("1000"), tokenAmount("2000")),
      pair(11, tokenB, tokenC, tokenAmount("1000"), tokenAmount("3000")),
      pair(12, tokenC, tokenD, tokenAmount("1000"), tokenAmount("2000")),
      pair(13, tokenD, tokenA, tokenAmount("1000"), tokenAmount("2000")),
    ]) graph.graph.addPair(pool);

    const opportunities = graph.findOpportunities({ startTokens: [tokenA, tokenB] });

    expect(opportunities.some(opportunity => opportunity.path[0] === tokenA)).toBe(true);
  });
});

