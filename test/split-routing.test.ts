import { expect, test } from 'bun:test';
import { MarketGraph } from '../src/market-graph/market-graph';
import { ARBITRAGE_SEARCH_POLICY, EXECUTION_POLICY, TOKENS } from '../src/constants';
import { type ArbitrageSearchPolicy } from '../src/market-graph/types';
import { quoteSplitStages, searchSplitRoutes } from '../src/opportunities/split-routing';
import { OpportunityEngine } from '../src/opportunities/opportunity-engine';
import { createExecutionPlan } from '../src/execution/execution-planner';
import { decodeFunctionData, encodeFunctionData } from 'viem';
import ArbABI from '../src/ABI/Arb.json';
import { splitGasCost } from '../src/opportunities/split-routing';
import { WorkerSearch } from '../src/opportunities/worker-search';
import { splitCostsFromSnapshot } from '../src/opportunities/split-costs';
import { quoteV3MultiRangeExactInput, Q96 } from '../src/protocols/v3/quote';
import { tickWordBounds } from '../src/protocols/v3/coverage';

const [a, b] = TOKENS.map(token => token.address);
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const;
const tokens = TOKENS.map(token => ({ ...token, minProfit: 1n }));
const fees = { type: 'eip1559', maxFeePerGas: EXECUTION_POLICY.maxFeePerGas,
  maxPriorityFeePerGas: EXECUTION_POLICY.maxPriorityFeePerGas, validUntil: Number.MAX_SAFE_INTEGER } as const;
function searchPolicy(): ArbitrageSearchPolicy {
  return { ...ARBITRAGE_SEARCH_POLICY, allowedProtocols: ['v2', 'v3', 'carbon'], splitRouting: 'shadow' as const, splitSearchMs: 1000,
    maxCandidatesToSize: 24, maxSearchExpansions: 100000, maxInputReserveFraction: 5n };
}
export function splitMarket(policy = searchPolicy()) {
  const graph = new MarketGraph(policy);
  for (const [id, r0, r1] of [[1, 1000n, 2000n], [2, 1000n, 2000n], [3, 2000n, 2000n], [4, 100000n, 100000n]] as const) {
    graph.addPair({ pairAddress: address(id), token0: a, token1: b, reserve0: r0, reserve1: r1,
      fee: 0, variant: 'uniswap-v2', scale0: 1n, scale1: 1n });
  }
  return graph;
}
export function edgeIndex(graph: MarketGraph, id: number, from = a) {
  return graph.edgeIndexesForTokenPool(graph.tokenIndexOf(from)!, graph.poolIndexOf(address(id))!)[0];
}

test('split stages preserve exact branch inputs and merge only their own proceeds', () => {
  const graph = splitMarket();
  const result = quoteSplitStages(graph, [a, b, a], [
    [{ edgeIndex: edgeIndex(graph, 1), amountIn: 100n }, { edgeIndex: edgeIndex(graph, 2), amountIn: 100n }],
    [{ edgeIndex: edgeIndex(graph, 3, b), amountIn: 362n }],
  ], 0);
  expect(result?.amountIn).toBe(200n);
  expect(result?.amountOut).toBe(306n);
  expect(result?.stages[0].branches.map(branch => branch.minAmountOut)).toEqual([181n, 181n]);
  expect(result?.stages[1].branches[0].amountIn).toBe(362n);
});

test('bounded search improves on a single pool without claiming shared liquidity twice', () => {
  const graph = splitMarket();
  const policy = searchPolicy();
  const result = searchSplitRoutes(graph, [[a, b, a]], tokens, {
    validUntil: Date.now() + 10000, gasPriceWei: 1n,
    rates: { [a.toLowerCase()]: { numerator: 1n, denominator: EXECUTION_POLICY.gasLimit } },
  });
  expect(result.best?.quote.stages.some(stage => stage.branches.length === 2)).toBe(true);
  expect(result.best!.netProfit).toBeGreaterThan(105n);
  expect(new Set(result.best!.quote.resources).size).toBe(result.best!.quote.resources.length);
  expect(result.work).toBeLessThanOrEqual(policy.maxSearchExpansions!);
});

test('engine finds splits before the single-route profit filter and encodes a staged entry point', () => {
  const policy = searchPolicy();
  const engine = new OpportunityEngine({ ...policy, maxRouteEdges: 2 }, [], tokens.map(token => ({ ...token, minProfit: 200n })));
  engine.graph.applyChanges(splitMarket().takeChanges(true));
  const results = engine.findOpportunities({ startTokens: [a], splitCosts: { validUntil: Date.now() + 10000,
    gasPriceWei: 1n, rates: { [a.toLowerCase()]: { numerator: 1n, denominator: EXECUTION_POLICY.gasLimit } } } });
  expect(results.filter(result => !result.split)).toHaveLength(0);
  const split = results.find(result => result.split)!;
  expect(split).toBeDefined();
  expect(split.split!.mode).toBe('shadow');
  expect(split.split!.minSurplusAfterRepayment).toBe(201n);
  const plan = createExecutionPlan(engine.graph, split);
  expect(plan?.kind).toBe('split');
  if (plan?.kind === 'split') expect(plan.params.stages[0].branches.length).toBeGreaterThan(0);
  expect(decodeFunctionData({ abi: ArbABI, data: encodeFunctionData({ abi: ArbABI, functionName: 'executeSplitArbitrage', args: [plan!.params] }) }).functionName).toBe('executeSplitArbitrage');
  engine.graph.updateReserves([{ pairAddress: split.pairs[1], reserve0: 1n, reserve1: 1n }]);
  expect(engine.graph.matchesVersions(split.marketVersions!)).toBe(false);
});


function costs() { return { validUntil: Date.now() + 60000, gasPriceWei: 1n, rates: { [a.toLowerCase()]: { numerator: 1n, denominator: EXECUTION_POLICY.gasLimit } } }; }

test('direct routes account for gas even when split routing is off', () => {
  const engine = new OpportunityEngine({ ...searchPolicy(), splitRouting: 'off', maxRouteEdges: 2 }, [], tokens);
  engine.graph.applyChanges(splitMarket().takeChanges(true));
  const gross = engine.findOpportunities({ startTokens: [a] });
  expect(gross.some(opportunity => !opportunity.split)).toBe(true);
  const cheap = engine.findOpportunities({ startTokens: [a], splitCosts: costs() });
  expect(cheap.some(opportunity => !opportunity.split && opportunity.netProfit === opportunity.profit - 1n)).toBe(true);
  const expensive = engine.findOpportunities({ startTokens: [a], splitCosts: { ...costs(), gasPriceWei: 1_000n } });
  expect(expensive).toHaveLength(0);
});

test('search matches a small exhaustive V2 allocation oracle within integer rounding', () => {
  let oracle = 0n;
  for (let input = 2n; input <= 400n; input++) for (let first = 1n; first < input; first++) {
    if (first > 200n || input - first > 200n) continue;
    const bought = (first * 2000n / (1000n + first)) * 9995n / 10000n + ((input - first) * 2000n / (1000n + input - first)) * 9995n / 10000n;
    const returned = (bought * 100000n / (100000n + bought)) * 9995n / 10000n;
    const net = returned - input - 1n;
    if (net > oracle) oracle = net;
  }
  const result = searchSplitRoutes(splitMarket(), [[a, b, a]], tokens, costs());
  expect(result.best!.netProfit).toBeLessThanOrEqual(oracle);
  expect(result.best!.netProfit).toBeGreaterThanOrEqual(oracle - 2n);
});

test('missing, expired and uneconomic cost data fail closed; off mode does no work', () => {
  const graph = splitMarket(); const policy = searchPolicy();
  expect(searchSplitRoutes(graph, [[a, b, a]], tokens).best).toBeNull();
  expect(searchSplitRoutes(graph, [[a, b, a]], tokens, { ...costs(), validUntil: Date.now() - 1 }).best).toBeNull();
  expect(searchSplitRoutes(graph, [[a, b, a]], tokens, { ...costs(), gasPriceWei: 10000n }).best).toBeNull();
  expect(searchSplitRoutes(splitMarket({ ...policy, splitRouting: 'off' }), [[a, b, a]], tokens, costs()).work).toBe(0);
  expect(searchSplitRoutes(graph, [[a, b, a]], tokens, costs(), new Map([[a.toLowerCase(), 1000n]])).best).toBeNull();
  expect(splitGasCost({ ...costs(), rates: { [a.toLowerCase()]: { numerator: 3n, denominator: EXECUTION_POLICY.gasLimit * 2n } } }, a)).toBe(2n);
});

test('gas conversion excludes expired tokens and uses the configured wrapped-native identity rate', () => {
  const configured = tokens.map(token => ({ ...token, gasConversion: { numerator: 1n, denominator: 3n, validUntil: 999 } }));
  const quote = splitCostsFromSnapshot(configured, fees, 1000);
  expect(quote.rates[b.toLowerCase()]).toBeUndefined();
  expect(quote.rates[a.toLowerCase()]).toEqual({ numerator: 1n, denominator: 1n });
  const fresh = splitCostsFromSnapshot(tokens.map(token => ({ ...token,
    gasConversion: { numerator: 3n, denominator: 2n, validUntil: 2000 },
  })), fees, 1000);
  expect(fresh.rates[b.toLowerCase()]).toMatchObject({ numerator: 3n, denominator: 2n });
  expect(fresh.rates[a.toLowerCase()]).toEqual({ numerator: 1n, denominator: 1n });
  expect(fresh.validUntil).toBe(2000);
});

test('budget exhaustion is reported, including work inside a V3 tick walk', () => {
  const policy = { ...searchPolicy(), maxSearchExpansions: 10 };
  const result = searchSplitRoutes(splitMarket(policy), [[a, b, a]], tokens, costs());
  expect(result.exhausted).toBe(true);
  expect(result.work).toBe(10);
  let work = 0;
  const quote = quoteV3MultiRangeExactInput({ amountIn: 100000n, sqrtPriceX96: Q96, liquidity: 100000n, tick: 0,
    fee: 0, direction: 'token1ToToken0', normalizedTicks: true, fullRange: true,
    ticks: Array.from({ length: 100 }, (_, i) => ({ index: i + 1, liquidityNet: 0n, liquidityGross: 1n })),
    spendWork: () => ++work <= 2 });
  expect(quote.exhaustedLiquidity).toBe(true);
  expect(quote.initializedTicksCrossed).toBe(2);
});

test('bounded and execution funding lookups agree when several lenders have equal fees', () => {
  const graph = splitMarket();
  graph.addPair({ pairAddress: address(5), token0: a, token1: b, reserve0: 1000000n, reserve1: 1000000n,
    fee: 0, variant: 'uniswap-v2', scale0: 1n, scale1: 1n });
  expect(graph.findBestFlashPoolForToken(a, 200n, [address(1), address(2)], () => true))
    .toEqual(graph.findBestFlashPoolForToken(a, 200n, [address(1), address(2)]));
});

test('quotes reject shared pools, discontinuous tokens and unfunded later-stage inputs', () => {
  const graph = splitMarket(); const first = { edgeIndex: edgeIndex(graph, 1), amountIn: 100n };
  expect(quoteSplitStages(graph, [a, b, a], [[first, first], [{ edgeIndex: edgeIndex(graph, 3, b), amountIn: 362n }]], 0)).toBeNull();
  expect(quoteSplitStages(graph, [a, b, a], [[first], [{ edgeIndex: edgeIndex(graph, 3, b), amountIn: 182n }]], 0)).toBeNull();
  expect(quoteSplitStages(graph, [a, a, a], [[first], [first]], 0)).toBeNull();
  expect(quoteSplitStages(graph, [a, b, a], [[first], [{ edgeIndex: edgeIndex(graph, 3, b), amountIn: 181n }]], 100)).toBeNull();
});

test('Carbon group and single overlap is rejected while independent Carbon and V3 branches quote', () => {
  const graph = splitMarket();
  graph.setCarbonStrategies([1n, 2n].map(id => ({ id, owner: address(99), controller: address(50), token0: a, token1: b, feePpm: 0,
    orders: [{ y: 0n, z: 0n, A: 0n, B: 0n }, { y: 1000n, z: 1000n, A: 0n, B: (1n << 48n) | (1n << 47n) }] })));
  const carbon = graph.rankedEdgeIndexes(graph.tokenIndexOf(a)!, 20).filter(index => graph.edgeAt(index)!.protocol === 'carbon');
  const group = carbon.find(index => (graph.edgeAt(index) as any).carbonKind === 'group')!;
  const single = carbon.find(index => (graph.edgeAt(index) as any).carbonKind === 'single')!;
  expect(quoteSplitStages(graph, [a, b, a], [[{ edgeIndex: group, amountIn: 100n }, { edgeIndex: single, amountIn: 100n }],
    [{ edgeIndex: edgeIndex(graph, 3, b), amountIn: 100n }]], 0)).toBeNull();
  const config = { name: 'split-v3', address: address(60), token0: a, token1: b, fee: 500, tickSpacing: 60, enabled: true };
  graph.replaceV3Snapshot(config, { poolAddress: config.address, blockNumber: 1n, blockHash: `0x${'0'.repeat(64)}`,
    ...tickWordBounds(60), complete: true, bitmapWords: [], ticks: [], sqrtPriceX96: Q96, liquidity: 1000000n, tick: 0 });
  const v3 = graph.edgeIndexesForTokenPool(graph.tokenIndexOf(a)!, graph.poolIndexOf(address(60))!)[0];
  const quote = quoteSplitStages(graph, [a, b, a], [[{ edgeIndex: single, amountIn: 100n }, { edgeIndex: v3, amountIn: 100n }],
    [{ edgeIndex: edgeIndex(graph, 3, b), amountIn: 190n }]], 0);
  expect(quote?.stages[0].branches.map(branch => branch.protocol)).toEqual(['carbon', 'v3']);
  const noMix = new MarketGraph({ ...ARBITRAGE_SEARCH_POLICY, allowProtocolMixing: false });
  noMix.applyChanges(graph.takeChanges(true));
  const noMixCarbon = noMix.rankedEdgeIndexes(noMix.tokenIndexOf(a)!, 20).find(index => noMix.edgeAt(index)!.protocol === 'carbon')!;
  expect(quoteSplitStages(noMix, [a, b, a], [[{ edgeIndex: noMixCarbon, amountIn: 100n }], [{ edgeIndex: edgeIndex(noMix, 3, b), amountIn: 50n }]], 0)).toBeNull();
});

test('worker carries shared tokens, policy and costs, preserves shadow plans, and rechecks every pool revision', async () => {
  const policy = searchPolicy(); const engine = new OpportunityEngine(policy, [], tokens);
  engine.graph.applyChanges(splitMarket().takeChanges(true));
  const worker = new WorkerSearch(engine.graph, engine.policy, tokens);
  const request = { startTokens: [a], observedAt: Date.now(), splitCosts: costs() };
  try {
    const expected = engine.findOpportunities(request);
    const actual = await worker.search(request);
    expect(actual).toEqual(expected);
    const split = actual.find(candidate => candidate.split)!;
    expect(split.split!.mode).toBe('shadow');
    engine.graph.updateReserves([{ pairAddress: split.flashPoolAddress!, reserve0: 90000n, reserve1: 90000n }]);
    expect(engine.graph.matchesVersions(split.marketVersions!)).toBe(false);
    expect(await worker.search(request)).toEqual(engine.findOpportunities(request));
  } finally { worker.stop(); }
}, 10000);

test('topTokens and the existing token minProfit govern both searches', () => {
  const snapshot = splitMarket().takeChanges(true);
  const engine = new OpportunityEngine({ ...searchPolicy(), topTokens: 1, maxRouteEdges: 2 }, [], tokens);
  engine.graph.applyChanges(snapshot);
  expect(engine.startTokens).toEqual([a]);
  const result = engine.findOpportunities({ startTokens: [a, b], splitCosts: costs() });
  expect(result.some(candidate => candidate.split)).toBe(true);
  expect(result.some(candidate => !candidate.split)).toBe(true);
  expect(result.every(candidate => candidate.path[0].toLowerCase() === a.toLowerCase())).toBe(true);
  expect(engine.findOpportunities({ startTokens: [b], splitCosts: costs() })).toEqual([]);
  expect(searchSplitRoutes(engine.graph, [[b, a, b]], tokens, {
    ...costs(), rates: { [b.toLowerCase()]: { numerator: 1n, denominator: EXECUTION_POLICY.gasLimit } },
  }).best).toBeNull();
  const expensive = new OpportunityEngine(engine.policy, [], tokens.map(token => ({ ...token, minProfit: 10000n })));
  expensive.graph.applyChanges(snapshot);
  expect(expensive.findOpportunities({ startTokens: [a], splitCosts: costs() })).toEqual([]);
});

test('opening branches share the linear reserve-fraction cap and profit floor', () => {
  for (const fraction of [5n, 20n]) {
    const graph = splitMarket({ ...searchPolicy(), maxInputReserveFraction: fraction });
    const candidate = searchSplitRoutes(graph, [[a, b, a]], tokens, costs()).best!;
    expect(candidate).not.toBeNull();
    const opening = candidate.quote.stages[0].branches;
    for (const branch of opening) {
      const index = graph.edgeIndexesForTokenPool(graph.tokenIndexOf(a)!, graph.poolIndexOf(branch.pool)!)[0];
      expect(branch.amountIn).toBeLessThanOrEqual(graph.maxInputForEdges([index]));
    }
    expect(candidate.minSurplusAfterRepayment).toBe(2n);
    expect(candidate.quote.amountOut - candidate.quote.amountIn).toBeGreaterThanOrEqual(candidate.minSurplusAfterRepayment);
  }
});

test('default TOKENS work without a second allowlist', () => {
  const engine = new OpportunityEngine({ ...searchPolicy(), maxRouteEdges: 2 });
  const unit = 10n ** 18n;
  for (const pair of splitMarket().getAllPairs()) {
    engine.graph.addPair({ ...pair, reserve0: pair.reserve0 * unit, reserve1: pair.reserve1 * unit });
  }
  const result = engine.findOpportunities({ startTokens: engine.startTokens, splitCosts: splitCostsFromSnapshot(TOKENS, fees) });
  expect(result.some(candidate => candidate.split && candidate.path[0] === a)).toBe(true);
  expect(result.filter(candidate => candidate.split).every(candidate => candidate.path[0] === a)).toBe(true);
});
