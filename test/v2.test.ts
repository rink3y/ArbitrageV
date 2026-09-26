import { MarketGraph } from '../src/market-graph/market-graph';
import { v2Pair as pair, address as pairAddress } from './helpers/markets';
import { describe, expect, test } from "bun:test";
import { type Address } from "viem";
import { ARBITRAGE_SEARCH_POLICY, CONFIGURED_TOKENS } from "../src/constants";
import { swapSolidlyStable, swapV2 } from "../src/protocols/v2/quote";
import { encodeV2RouteData } from "../src/protocols/v2/execution";
import { type PairInfo } from "../src/protocols/v2/types";
import { type ArbitrageSearchPolicy } from "../src/market-graph/types";
import { OpportunityEngine } from "../src/opportunities/opportunity-engine";
import { tokenAmount } from "../src/values";
import { getKnownPairsInfo } from '../src/protocols/v2/runtime';
import { V2_DISCOVERY_POLICY } from '../src/protocols/v2/config';

const [tokenA, tokenB, tokenC] = CONFIGURED_TOKENS.map(({ address }) => address);

function tokenAddress(id: number): Address {
  return `0x${(100000 + id).toString(16).padStart(40, "0")}` as Address;
}

function buildGraph(pairs: PairInfo[]): OpportunityEngine {
  const graph = new OpportunityEngine();
  for (const pool of pairs) {
    graph.graph.addPair(pool);
  }
  return graph;
}

test('V2 loading uses the raw fallback only when neither token is configured', async () => {
  const minimum = V2_DISCOVERY_POLICY.minOtherTokenLiquidity;
  expect(minimum).toBe(tokenAmount('500'));
  const configured = CONFIGURED_TOKENS[0];
  const other = CONFIGURED_TOKENS.find(token => token.address !== configured.address)!;
  const unknownA = tokenAddress(900), unknownB = tokenAddress(901);
  const cases: Array<[Address, Address, bigint, bigint, boolean]> = [
    [unknownA, unknownB, minimum - 1n, minimum - 1n, false],
    [unknownA, unknownB, minimum, 1n, true],
    [unknownA, unknownB, 1n, minimum, true],
    [unknownA, unknownB, minimum, 0n, false],
    [configured.address, unknownB, configured.liquidityAmount, 1n, true],
    [unknownA, configured.address, 1n, configured.liquidityAmount, true],
    [configured.address, unknownB, configured.liquidityAmount - 1n, minimum, false],
    [configured.address, other.address, configured.liquidityAmount, other.liquidityAmount - 1n, false],
  ];
  for (const [token0, token1, reserve0, reserve1, admitted] of cases) {
    const pools = [{ pairAddress: pairAddress(999), token0, token1, fee: 30, factory: 'test',
      variant: 'uniswap-v2' as const, scale0: 1n, scale1: 1n }];
    const result = await getKnownPairsInfo({ readContract: async () =>
      [[reserve0, reserve1, BigInt(Math.floor(Date.now() / 1000))]] }, pools);
    expect(result).toHaveLength(admitted ? 1 : 0);
  }
});

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
    // Tax-aware custody adds bit 1; the stable-pool bit remains set only on the first hop.
    expect(opportunity.routeData).toEqual(['0x03', '0x02', '0x02']);
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
    expect(opportunities[0].profit).toBeGreaterThan(CONFIGURED_TOKENS[0].minProfitNative ?? 0n);
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
  });

  test("does not reuse the same pair to manufacture a false two-hop cycle", () => {
    const graph = buildGraph([
      pair(1, tokenA, tokenAddress(902), tokenAmount("1000"), tokenAmount("5000")),
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
    expect(opportunities[0].profit).toBeGreaterThan(CONFIGURED_TOKENS[0].minProfitNative ?? 0n);
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
    expect(opportunities[0].profit).toBeGreaterThan(CONFIGURED_TOKENS[0].minProfitNative ?? 0n);
    expect(opportunities[0].optimalInput).toBeGreaterThan(9007199254740991n);
    expect(typeof opportunities[0].profit).toBe("bigint");
    expect(typeof opportunities[0].optimalInput).toBe("bigint");
  });

  test("a wider search budget keeps the profitable route visible among 500 irrelevant pairs", () => {
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

    const graph = new OpportunityEngine({ ...ARBITRAGE_SEARCH_POLICY, beamWidth: 512,
      maxCandidatesToSize: 512, maxSearchExpansions: 500_000 });
    for (const pool of [
      ...distractors,
      pair(1, tokenA, tokenB, tokenAmount("1000"), tokenAmount("2200")),
      pair(2, tokenB, tokenC, tokenAmount("1000"), tokenAmount("2200")),
      pair(3, tokenC, tokenA, tokenAmount("1000"), tokenAmount("2200")),
    ]) graph.graph.addPair(pool);

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

test('cached flash-source ordering matches exhaustive selection across amounts and exclusions', () => {
  const graph = new MarketGraph({ ...ARBITRAGE_SEARCH_POLICY, allowedProtocols: ['v2'] });
  const token = CONFIGURED_TOKENS[0].address;
  for (const [id, fee, reserve] of [[1, 30, 1_000_000], [2, 15, 100], [3, 17, 1_000_000], [4, 15, 1_000_000]] as const) {
    graph.addPair({ pairAddress: pairAddress(id), token0: token, token1: pairAddress(id + 100),
      reserve0: BigInt(reserve), reserve1: BigInt(reserve), fee, variant: 'uniswap-v2', scale0: 1n, scale1: 1n });
  }
  for (const amount of [1n, 99n, 100n, 100_000n, 1_000_000n]) {
    for (const excluded of [[], [pairAddress(4)], [pairAddress(2), pairAddress(4)]]) {
      expect(graph.findBestFlashPoolForToken(token, amount, excluded))
        .toEqual(graph.findBestFlashPoolForToken(token, amount, excluded, () => true));
    }
  }
  graph.updateReserves([{ pairAddress: pairAddress(4), reserve0: 0n, reserve1: 0n }]);
  for (const amount of [1n, 99n, 100n, 100_000n]) {
    expect(graph.findBestFlashPoolForToken(token, amount))
      .toEqual(graph.findBestFlashPoolForToken(token, amount, [], () => true));
  }
});

