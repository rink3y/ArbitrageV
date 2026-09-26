import { afterEach, expect, test } from 'bun:test';
import { ARBITRAGE_SEARCH_POLICY, CONTRACTS, EXECUTION_POLICY, WRAPPED_NATIVE_TOKENS, type TokenConfig } from '../src/constants';
import { OpportunityEngine } from '../src/opportunities/opportunity-engine';
import { projectOpportunity } from '../src/opportunities/projected-state';
import { nativeValue } from '../src/opportunities/native-valuation';
import { splitCostsFromSnapshot } from '../src/opportunities/split-costs';
import { createExecutionPlan } from '../src/execution/execution-planner';
import { filterDiscoveredMarkets } from '../src/market-filter';
import { type ArbitrageOpportunity } from '../src/opportunities/opportunity-types';
import { Q96 } from '../src/protocols/v3/quote';
import { encodeCarbonRouteData } from '../src/protocols/carbon/execution';
import { type CarbonStrategy } from '../src/protocols/carbon/types';
import { address, v2Pair } from './helpers/markets';

const a = WRAPPED_NATIVE_TOKENS[0].address, b = address(102), c = address(103), unit = 10n ** 18n;
const oldAddress = CONTRACTS.arbitrage, oldExecution = { ...EXECUTION_POLICY }, oldWrappers = [...WRAPPED_NATIVE_TOKENS];
afterEach(() => {
  Object.assign(CONTRACTS, { arbitrage: oldAddress });
  Object.assign(EXECUTION_POLICY, oldExecution);
  WRAPPED_NATIVE_TOKENS.splice(0, WRAPPED_NATIVE_TOKENS.length, ...oldWrappers);
});
function market(tokens: TokenConfig[] = [{ address: a, name: 'native', decimals: 18, liquidityAmount: 1n }]) {
  Object.assign(CONTRACTS, { arbitrage: address(999) });
  Object.assign(EXECUTION_POLICY, { routeSwapFunding: true, followUpMode: 'off', followUpSearchMs: 100 });
  const engine = new OpportunityEngine({ ...ARBITRAGE_SEARCH_POLICY, allowedProtocols: ['v2', 'v3', 'carbon'],
    splitRouting: 'off', maxInputReserveFraction: 5n, minProfitNative: 1n }, [], tokens);
  engine.graph.addPair(v2Pair(1, a, b, 1000n * unit, 1000n * unit));
  engine.graph.addPair(v2Pair(2, a, b, 2000n * unit, 1000n * unit));
  engine.graph.addPair(v2Pair(3, a, b, 1400n * unit, 1000n * unit));
  return engine;
}
const costs = () => splitCostsFromSnapshot({ type: 'legacy', gasPrice: 1n, validUntil: Date.now() + 60000 });
function first(engine: OpportunityEngine) {
  return engine.findOpportunities({ startTokens: [a], splitCosts: costs() })[0];
}
test('projection changes only hypothetical reserves and restores state, versions and quotes on throw', () => {
  const engine = market();
  const opportunity = first(engine);
  expect(opportunity.routeSwap).toBe(true);
  const before = structuredClone(engine.graph.takeChanges(true));
  const changes = projectOpportunity(engine.graph, opportunity)!;
  expect(changes).not.toBeNull();
  expect(engine.graph.getPair(opportunity.pairs[0])?.reserve0).toBe(before.pairs.find(pair => pair.pairAddress === opportunity.pairs[0])!.reserve0);
  expect(() => engine.graph.withProjectedChanges(changes, () => {
    expect(engine.graph.getPair(opportunity.pairs[0])?.reserve0).not.toBe(before.pairs.find(pair => pair.pairAddress === opportunity.pairs[0])!.reserve0);
    throw new Error('test restore');
  })).toThrow('test restore');
  expect(engine.graph.takeChanges(true)).toEqual(before);
  expect(first(engine).profit).toBe(opportunity.profit);
});
test('native valuation uses actual surplus size and updates with local events', () => {
  const engine = market();
  const small = nativeValue(engine.graph, b, unit)!;
  const large = nativeValue(engine.graph, b, 100n * unit)!;
  expect(large.amount).toBeLessThan(small.amount * 100n);
  engine.graph.updateReserves([{ pairAddress: address(2), reserve0: 4000n * unit, reserve1: 1000n * unit }]);
  expect(nativeValue(engine.graph, b, unit)!.amount).toBeGreaterThan(small.amount);
  expect(nativeValue(engine.graph, c, unit)).toBeNull();
});
test('empty CONFIGURED_TOKENS auto-selects valued graph tokens and uses the shared native profit floor', () => {
  const engine = market([]);
  const results = engine.findOpportunities({ startTokens: [], autoSelect: true, splitCosts: costs() });
  expect(results.length).toBeGreaterThan(0);
  expect(results.every(result => result.netProfitNative! > 1n)).toBe(true);
  engine.policy.minProfitNative = 10000n * unit;
  expect(engine.findOpportunities({ startTokens: [], autoSelect: true, splitCosts: costs() })).toHaveLength(0);
});
test('a token override uses native wei, not token decimals or a ranking denominator', () => {
  const engine = market([{ address: a, name: 'native', decimals: 18, liquidityAmount: 1n, minProfitNative: 10000n * unit }]);
  expect(first(engine)).toBeUndefined();
});

test('six-decimal direct and split profits use a native-denominated override', () => {
  const engine = market([{ address: b, name: 'six decimals', decimals: 6, liquidityAmount: 1n, minProfitNative: unit / 1000n }]);
  for (const pair of engine.graph.takeChanges(true).pairs) engine.graph.addPair({ ...pair, reserve1: pair.reserve1 / (10n ** 12n) });
  engine.graph.addPair(v2Pair(4, a, b, 2000n * unit, 1000n * 1000000n));
  engine.policy.splitRouting = 'live'; engine.policy.splitSearchMs = 1000;
  const results = engine.findOpportunities({ startTokens: [b], splitCosts: costs() });
  expect(results.some(result => !result.split)).toBe(true);
  expect(results.some(result => result.split)).toBe(true);
  expect(results.every(result => result.profit < unit / 1000n && result.netProfitNative! > unit / 1000n)).toBe(true);
});
test('approved wrapper closure discovers a single-swap route and preserves it through filtering', () => {
  WRAPPED_NATIVE_TOKENS.push({ address: b, name: 'second wrapper', decimals: 18, liquidityAmount: 0n });
  const engine = market();
  engine.graph.removePair(address(2)); engine.graph.removePair(address(3));
  engine.graph.updateReserves([{ pairAddress: address(1), reserve0: 1000n * unit, reserve1: 2000n * unit }]);
  const result = first(engine);
  expect(result.path).toEqual([a, b]);
  expect(result.pairs).toHaveLength(1);
  expect(createExecutionPlan(engine.graph, result)?.kind).toBe('plan');
  const pair = { ...v2Pair(1, a, b, unit, unit), factory: address(100), name: 'wrapper pair' };
  expect(filterDiscoveredMarkets([pair] as never, [], []).v2Pools).toHaveLength(1);
});
test.each(['separate', 'batch'] as const)('%s prepares one successor with observed-state dependencies without changing the graph', mode => {
  const engine = market();
  Object.assign(EXECUTION_POLICY, { followUpMode: mode });
  const before = structuredClone(engine.graph.takeChanges(true));
  const result = first(engine);
  expect(result.followUp).toBeDefined();
  expect(result.followUpPlan).toBeDefined();
  expect(result.followUp?.followUp).toBeUndefined();
  expect(engine.graph.matchesVersions(result.followUp!.marketVersions!)).toBe(true);
  expect(engine.graph.takeChanges(true)).toEqual(before);
  engine.graph.updateReserves([{ pairAddress: result.pairs[0], reserve0: unit, reserve1: unit }]);
  expect(engine.graph.matchesVersions(result.followUp!.marketVersions!)).toBe(false);
});
test('off does not create a follow-up and taxed transfers do not seed speculative state', () => {
  const engine = market();
  const result = first(engine);
  expect(result.followUp).toBeUndefined();
  const pair = engine.graph.getPair(result.pairs[0])!;
  pair.transferProfiles!.token0.sell.feeBps = 100;
  expect(projectOpportunity(engine.graph, result)).toBeNull();
});
test('V3 projection carries price, tick and active liquidity, and restores observed state', () => {
  const engine = market();
  const pool = { name: 'v3', address: address(10), token0: a, token1: b, fee: 3000, tickSpacing: 60, enabled: true };
  engine.graph.replaceV3Snapshot(pool, { poolAddress: pool.address, blockNumber: 1n, blockHash: ('0x' + '00'.repeat(32)) as `0x${string}`,
    minWord: -58, maxWord: 57, complete: true, bitmapWords: [], ticks: [
      { index: -60, liquidityGross: 500n * unit, liquidityNet: 500n * unit },
      { index: -120, liquidityGross: 100n * unit, liquidityNet: 100n * unit },
    ],
    sqrtPriceX96: Q96, tick: 0, liquidity: 1000n * unit });
  // A second V2 pool turns the V3 output back into the starting token.
  const opportunity: ArbitrageOpportunity = { path: [a, b, a], pairs: [pool.address, address(2)], protocols: ['v3', 'v2'],
    fees: [3000, 30], edgeIds: [], routeData: ['0x', '0x02'], optimalInput: 10n * unit, profit: 1n,
    routeSwap: true, flashPoolAddress: pool.address };
  const changes = projectOpportunity(engine.graph, opportunity)!;
  expect(changes.v3[0].state!.sqrtPriceX96).toBeLessThan(Q96);
  expect(changes.v3[0].state!.tick).toBeLessThan(-120);
  expect(changes.v3[0].state!.liquidity).toBe(400n * unit);
  engine.graph.withProjectedChanges(changes, () => expect(engine.graph.getV3Pool(pool.address)!.state!.sqrtPriceX96).toBeLessThan(Q96));
  expect(engine.graph.getV3Pool(pool.address)!.state!.sqrtPriceX96).toBe(Q96);
});
test('Carbon projection decreases sold inventory and grows the opposite order including z', () => {
  const engine = market();
  const controller = address(20);
  const strategy: CarbonStrategy = { id: 1n, owner: address(999), controller, token0: a, token1: b, feePpm: 0,
    orders: [{ y: 0n, z: 1n, A: 0n, B: 3n << 47n }, { y: 100n * unit, z: 100n * unit, A: 0n, B: 3n << 47n }] };
  engine.graph.setCarbonStrategies([strategy]);
  const opportunity: ArbitrageOpportunity = { path: [a, b, a], pairs: [controller, address(2)], protocols: ['carbon', 'v2'],
    fees: [0, 30], edgeIds: [], routeData: [encodeCarbonRouteData({ rawFrom: a, rawTo: b, strategyIds: [1n], amounts: [unit] }), '0x02'],
    optimalInput: unit, profit: 1n, flashPoolAddress: engine.graph.findBestFlashPoolForToken(a, unit, [controller, address(2)])!.poolAddress };
  const changes = projectOpportunity(engine.graph, opportunity)!;
  expect(changes?.carbon?.kind).toBe('delta');
  if (changes.carbon?.kind !== 'delta') throw Error('missing Carbon update');
  expect(changes.carbon.upserts[0].orders[1].y).toBe(99n * unit);
  expect(changes.carbon.upserts[0].orders[0].y).toBe(unit);
  expect(changes.carbon.upserts[0].orders[0].z).toBe(unit);
  engine.graph.withProjectedChanges(changes, () => expect(engine.graph.getCarbonStrategy(controller, 1n)!.orders[0].y).toBe(unit));
  expect(engine.graph.getCarbonStrategy(controller, 1n)!.orders[0].y).toBe(0n);
});
