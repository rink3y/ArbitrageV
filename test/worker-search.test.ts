import { expect, test } from 'bun:test';
import { ARBITRAGE_SEARCH_POLICY, RUNTIME, TOKENS } from '../src/constants';
import { OpportunityEngine } from '../src/opportunities/opportunity-engine';
import { WorkerSearch } from '../src/opportunities/worker-search';
import { MarketGraph } from '../src/market-graph/market-graph';
import { address, hash, pool } from './helpers/v3-fixture';
import { tickWordBounds } from '../src/protocols/v3/coverage';
import { type CarbonStrategy } from '../src/protocols/carbon/types';

const policy = { ...ARBITRAGE_SEARCH_POLICY, beamWidth: 8, maxRouteEdges: 3, maxCandidatesToSize: 4 };
const [a, b, c] = TOKENS.map(token => token.address);
function market() {
  const engine = new OpportunityEngine(policy);
  for (const [i, token0, token1] of [[1, a, b], [2, b, c], [3, c, a], [4, a, b]] as const) {
    engine.graph.addPair({ pairAddress: address(i), token0, token1, reserve0: 10n ** 24n, reserve1: 2n * 10n ** 24n,
      fee: 30, variant: 'uniswap-v2', scale0: 1n, scale1: 1n });
  }
  return engine;
}

test('worker matches local quotes, mirrors compact changes, and leaves ingestion runnable', async () => {
  const engine = market();
  const search = new WorkerSearch(engine.graph, policy);
  const request = { startTokens: [a], observedAt: Date.now() };
  try {
    const expected = engine.findOpportunities(request);
    expect(expected.length).toBeGreaterThan(0);
    const pending = search.search(request);
    let ingested = false;
    await new Promise<void>(resolve => setImmediate(() => { ingested = true; resolve(); }));
    const actual = await pending;
    expect(ingested).toBe(true);
    expect(actual).toEqual(expected);
    const versions = actual[0].marketVersions!;
    expect(engine.graph.matchesVersions(versions)).toBe(true);
    engine.graph.updateReserves([{ pairAddress: actual[0].pairs[0], reserve0: 10n ** 24n, reserve1: 3n * 10n ** 24n }]);
    expect(engine.graph.matchesVersions(versions)).toBe(false);
    const updated = await search.search(request);
    expect(updated).toEqual(engine.findOpportunities(request));
    engine.graph.setFeedReady(false);
    expect(engine.graph.matchesVersions(updated[0].marketVersions!)).toBe(false);
  } finally { search.stop(); }
}, 20_000);

test('worker queue rejects a second in-flight job and stop rejects pending work', async () => {
  const engine = market();
  const search = new WorkerSearch(engine.graph, policy);
  const pending = search.search({ startTokens: [a] });
  const rejection = pending.catch(error => error as Error);
  const second = search.search({ startTokens: [a] }).catch(error => error as Error);
  search.stop();
  expect(await second).toBeInstanceOf(Error);
  expect((await rejection as Error).message).toContain('stopped');
});

test('V3 worker patches merge state and tick updates without resending the full range', () => {
  const source = new MarketGraph(policy);
  const target = new MarketGraph(policy);
  const selected = pool();
  source.replaceV3Snapshot(selected, { poolAddress: selected.address, blockNumber: 1n, blockHash: hash(1n),
    ...tickWordBounds(selected.tickSpacing), complete: true, bitmapWords: [], ticks: [], sqrtPriceX96: 2n ** 96n, liquidity: 0n, tick: 0 });
  target.applyChanges(source.takeChanges(true));
  for (let value = 1n; value <= 100n; value++) {
    source.updateV3Ticks([{ poolAddress: selected.address, ticks: [{ index: 0, liquidityGross: value, liquidityNet: value }] }]);
    source.updateV3PoolStates([{ poolAddress: selected.address, sqrtPriceX96: 2n ** 96n, liquidity: value, tick: 0 }]);
  }
  const changes = source.takeChanges();
  expect(changes.pairs).toHaveLength(0);
  expect(changes.v3).toHaveLength(1);
  expect(changes.v3[0].replaceTicks).toBe(false);
  expect(changes.v3[0].ticks).toEqual([{ index: 0, liquidityGross: 100n, liquidityNet: 100n }]);
  target.applyChanges(changes);
  expect(target.getV3Pool(selected.address)!.state).toEqual(source.getV3Pool(selected.address)!.state);
  expect(target.getV3InitializedTicks(selected.address)).toEqual(source.getV3InitializedTicks(selected.address));
  source.updateV3Ticks([{ poolAddress: selected.address, ticks: [{ index: 0, liquidityGross: 0n, liquidityNet: 0n }] }]);
  target.applyChanges(source.takeChanges());
  expect(target.getV3InitializedTicks(selected.address)).toEqual([]);
  source.invalidateV3Pool(selected.address);
  target.applyChanges(source.takeChanges());
  expect(target.getV3Pool(selected.address)?.fullRange).toBe(false);
});

test('V2 and V3 removals are mirrored to the worker graph and can be re-added', () => {
  const source = new MarketGraph(policy);
  const target = new MarketGraph(policy);
  const pair = { pairAddress: address(70), token0: a, token1: b, reserve0: 1000n, reserve1: 1000n,
    fee: 30, variant: 'uniswap-v2' as const, scale0: 1n, scale1: 1n };
  const selected = pool(71);
  source.addPair(pair);
  source.replaceV3Snapshot(selected, { poolAddress: selected.address, blockNumber: 1n, blockHash: hash(1n),
    ...tickWordBounds(selected.tickSpacing), complete: true, bitmapWords: [], ticks: [], sqrtPriceX96: 2n ** 96n, liquidity: 1000n, tick: 0 });
  target.applyChanges(source.takeChanges(true));

  source.removePair(pair.pairAddress);
  source.removeV3Pool(selected.address);
  const changes = source.takeChanges();
  expect(changes.removedPairs).toEqual([pair.pairAddress]);
  expect(changes.removedV3).toEqual([selected.address]);
  target.applyChanges(changes);
  expect(target.getAllPairs()).toEqual([]);
  expect(target.getV3Pools()).toEqual([]);

  source.addPair(pair);
  source.replaceV3Snapshot(selected, { poolAddress: selected.address, blockNumber: 2n, blockHash: hash(2n),
    ...tickWordBounds(selected.tickSpacing), complete: true, bitmapWords: [], ticks: [], sqrtPriceX96: 2n ** 96n, liquidity: 1000n, tick: 0 });
  target.applyChanges(source.takeChanges());
  expect(target.getAllPairs()).toHaveLength(1);
  expect(target.getV3Pools()).toHaveLength(1);
});

test('exact route sizing is capped and event-local results touch a changed pool', () => {
  const engine = market();
  const opportunities = engine.findOpportunities({ startTokens: [a], changedPairs: [address(1)] });
  expect(engine.lastSearchStats.sized).toBeLessThanOrEqual(policy.maxCandidatesToSize);
  expect(opportunities.length).toBeGreaterThan(0);
  expect(opportunities.every(opportunity => opportunity.pairs.includes(address(1)))).toBe(true);
  expect(() => new OpportunityEngine({ ...policy, maxSearchExpansions: 0 })).toThrow();
});

test('a timed-out worker restarts from a full current graph, including updates drained by the failed job', async () => {
  const engine = market();
  const search = new WorkerSearch(engine.graph, policy);
  const previous = RUNTIME.searchTimeoutMs;
  try {
    Object.assign(RUNTIME, { searchTimeoutMs: 1 });
    await expect(search.search({ startTokens: [a] })).rejects.toThrow('timed out');
    Object.assign(RUNTIME, { searchTimeoutMs: previous });
    engine.graph.updateReserves([{ pairAddress: address(1), reserve0: 10n ** 24n, reserve1: 3n * 10n ** 24n }]);
    const request = { startTokens: [a], observedAt: Date.now() };
    expect(await search.search(request)).toEqual(engine.findOpportunities(request));
  } finally { Object.assign(RUNTIME, { searchTimeoutMs: previous }); search.stop(); }
}, 20_000);

test('Carbon replacement and deletion are mirrored and invalidate Carbon candidates', () => {
  const source = market();
  const target = new OpportunityEngine(policy);
  source.graph.setCarbonStrategies([{ id: 1n, owner: address(99), controller: address(90), token0: a, token1: b, feePpm: 0,
    orders: [{ y: 0n, z: 0n, A: 0n, B: 0n }, { y: 10n ** 24n, z: 10n ** 24n, A: 0n, B: (1n << 47n) | (2n << 48n) }] }]);
  target.graph.applyChanges(source.graph.takeChanges(true));
  const request = { startTokens: [a], observedAt: Date.now() };
  expect(target.findOpportunities(request)).toEqual(source.findOpportunities(request));
  const versions = source.graph.marketVersions([], true);
  source.graph.setCarbonStrategies([]);
  expect(source.graph.matchesVersions(versions)).toBe(false);
  target.graph.applyChanges(source.graph.takeChanges());
  expect(target.findOpportunities(request)).toEqual(source.findOpportunities(request));
});

test('Carbon worker deltas preserve quotes and execution data, including restart and updates during search', async () => {
  const carbonPolicy = { ...policy, maxCandidatesToSize: 16, maxRouteEdges: 2 };
  const engine = new OpportunityEngine(carbonPolicy);
  engine.graph.addPair({ pairAddress: address(80), token0: a, token1: b, fee: 30,
    reserve0: 10n ** 30n, reserve1: 10n ** 24n, variant: 'uniswap-v2', scale0: 1n, scale1: 1n });
  const strategies: CarbonStrategy[] = [1n, 2n, 3n].map(id => ({
    id, controller: address(90), owner: address(99), token0: a, token1: b, feePpm: 0,
    orders: [{ y: 0n, z: 0n, A: 0n, B: 0n }, { y: 10n ** 27n, z: 10n ** 27n, A: 0n, B: (1n << 47n) | (2n << 48n) }],
  }));
  engine.graph.setCarbonStrategies(strategies);
  const search = new WorkerSearch(engine.graph, carbonPolicy);
  const request = { startTokens: [a], observedAt: Date.now() };
  // Edge slots belong to each graph, not to the transaction encoding.
  const comparable = (results: ReturnType<OpportunityEngine['findOpportunities']>) =>
    results.map(({ edgeIndexes: _, ...result }) => result);
  try {
    const initial = await search.search(request);
    expect(initial.some(result => result.protocols.includes('carbon'))).toBe(true);
    expect(comparable(initial)).toEqual(comparable(engine.findOpportunities(request)));
    engine.graph.updateCarbonStrategies({ upserts: [{ ...strategies[0], orders: [strategies[0].orders[0], { ...strategies[0].orders[1], y: 5n * 10n ** 26n }] }], removed: [] });
    const pending = search.search(request);
    engine.graph.updateCarbonStrategies({ upserts: [], removed: [strategies[1]] });
    const stale = await pending;
    expect(stale.some(result => result.protocols.includes('carbon'))).toBe(true);
    expect(stale.filter(result => result.protocols.includes('carbon')).every(result => !engine.graph.matchesVersions(result.marketVersions!))).toBe(true);
    expect(comparable(await search.search(request))).toEqual(comparable(engine.findOpportunities(request)));
    engine.graph.updateCarbonStrategies({ upserts: [], removed: [strategies[2]] });
    expect(comparable(await search.search(request))).toEqual(comparable(engine.findOpportunities(request)));
    const restarted = new WorkerSearch(engine.graph, carbonPolicy);
    try {
      expect(comparable(await restarted.search(request))).toEqual(comparable(engine.findOpportunities(request)));
    } finally { restarted.stop(); }
  } finally { search.stop(); }
}, 20_000);
