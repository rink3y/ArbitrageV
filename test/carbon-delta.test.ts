import { NETWORK } from '../src/constants';
import { expect, test } from 'bun:test';
import { type Address } from 'viem';
import { ARBITRAGE_SEARCH_POLICY } from '../src/constants';
import { MarketGraph } from '../src/market-graph/market-graph';
import { carbonStrategyKey, type CarbonDelta, type CarbonStrategy } from '../src/protocols/carbon/types';
import { NATIVE_TOKEN } from '../src/tokens';

const WRAPPED_NATIVE = NETWORK.wrappedNativeToken;

const address = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const controller = address(1);
const policy = { ...ARBITRAGE_SEARCH_POLICY, allowedProtocols: ['carbon'] as const };
const order = (y = 1000n) => ({ y, z: 1000n, A: 0n, B: (1n << 47n) | (2n << 48n) });
function strategy(id: number, token0 = address(2), token1 = address(3)): CarbonStrategy {
  return { id: BigInt(id), controller, owner: address(9), token0, token1, feePpm: 4000, orders: [order(), order()] };
}
function active(graph: MarketGraph) {
  return Array.from({ length: graph.tokenCount() }, (_, token) => graph.rankedEdgeIndexes(token, 10000))
    .flat().map(index => ({ index, edge: graph.edgeAt(index)! })).sort((a, b) => a.edge.id.localeCompare(b.edge.id));
}
function equivalent(actual: MarketGraph, expected: MarketGraph) {
  const left = active(actual);
  const right = active(expected);
  expect(left.map(item => item.edge)).toEqual(right.map(item => item.edge));
  for (let i = 0; i < left.length; i++) {
    for (const amount of [1n, 100n, 400n, 10000n]) {
      expect(actual.quoteEdgeAt(left[i].index, amount)).toEqual(expected.quoteEdgeAt(right[i].index, amount));
      expect(actual.carbonExecution(left[i].index, amount)).toEqual(expected.carbonExecution(right[i].index, amount));
    }
  }
}

test('Carbon deltas match full rebuilds through updates, top-eight promotion, deletion and recreation', () => {
  const catalog = new Map(Array.from({ length: 12 }, (_, i) => strategy(i + 1)).map(s => [carbonStrategyKey(s), s]));
  const source = new MarketGraph(policy);
  const mirror = new MarketGraph(policy);
  source.setCarbonStrategies([...catalog.values()]);
  mirror.applyChanges(structuredClone(source.takeChanges(true)));
  const apply = (delta: CarbonDelta) => {
    for (const ref of delta.removed) catalog.delete(carbonStrategyKey(ref));
    for (const s of delta.upserts) catalog.set(carbonStrategyKey(s), s);
    source.updateCarbonStrategies(delta);
    mirror.applyChanges(structuredClone(source.takeChanges()));
    const rebuilt = new MarketGraph(policy);
    // Reverse input order to exercise deterministic marginal-rate ties.
    rebuilt.setCarbonStrategies([...catalog.values()].reverse());
    equivalent(source, rebuilt);
    equivalent(mirror, rebuilt);
    expect(mirror.marketVersions([], true)).toEqual(source.marketVersions([], true));
  };
  const groupId = `carbon-group:${controller}:${address(2)}:${address(3)}`;
  const deletedIndex = active(source).find(item => item.edge.id === `${carbonStrategyKey(strategy(1))}:1`)!.index;
  const groupIds = () => {
    const edge = source.edge(groupId)!;
    return edge.protocol === 'carbon' && edge.carbonKind === 'group' ? edge.orders.map(o => o.strategyId) : [];
  };
  expect(groupIds()).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]);
  apply({ upserts: [], removed: [{ controller, id: 1n }] });
  expect(source.quoteEdgeAt(deletedIndex, 100n).complete).toBe(false);
  expect(source.carbonExecution(deletedIndex, 100n)).toBeNull();
  expect(groupIds()).toEqual([2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n]);
  apply({ upserts: [{ ...strategy(2), orders: [order(0n), order(0n)] }], removed: [] });
  apply({ upserts: [{ ...strategy(12), orders: [order(500n), { ...order(), B: (1n << 47n) | (3n << 48n) }] }], removed: [] });
  expect(groupIds()[0]).toBe(12n);
  apply({ upserts: [strategy(1)], removed: [] });
  // Both directions must lose their group when fewer than two live orders remain.
  apply({ upserts: [], removed: [...catalog.values()].filter(s => s.id !== 1n) });
  expect(source.edge(groupId)?.liquidity).toBe(0n);
  apply({ upserts: [], removed: [strategy(1)] });
  expect(active(source)).toEqual([]);
  apply({ upserts: [strategy(1), strategy(2)], removed: [] });
});

test('a delta leaves unrelated pair edges and ranking caches intact', () => {
  const graph = new MarketGraph(policy);
  const other = [strategy(3, address(4), address(5)), strategy(4, address(4), address(5))];
  graph.setCarbonStrategies([strategy(1), strategy(2), ...other]);
  graph.takeChanges();
  const token = graph.tokenIndexOf(address(4))!;
  const ranked = graph.rankedEdgeIndexes(token, 100);
  const group = graph.edge(`carbon-group:${controller}:${address(4)}:${address(5)}`)!;
  const orders = group.protocol === 'carbon' && group.carbonKind === 'group' ? group.orders : [];
  graph.updateCarbonStrategies({ upserts: [{ ...strategy(1), orders: [order(100n), order(200n)] }], removed: [] });
  expect(graph.rankedEdgeIndexes(token, 100)).toBe(ranked);
  expect(group.protocol === 'carbon' && group.carbonKind === 'group' && group.orders).toBe(orders);
  expect(graph.takeChanges().carbon).toMatchObject({ kind: 'delta', upserts: [{ id: 1n }], removed: [] });
  expect(graph.takeChanges().carbon).toBeUndefined();
});

test('patches coalesce final strategy states and recovery snapshots include drained and queued changes', () => {
  const source = new MarketGraph(policy);
  const mirror = new MarketGraph(policy);
  source.setCarbonStrategies([strategy(1), strategy(2)]);
  source.updateCarbonStrategies({ upserts: [strategy(3)], removed: [strategy(1)] });
  const initial = source.takeChanges();
  expect(initial.carbon?.kind).toBe('snapshot');
  mirror.applyChanges(initial);
  for (let i = 1; i <= 100; i++) {
    source.updateCarbonStrategies({ upserts: [{ ...strategy(2), orders: [order(BigInt(i)), order()] }], removed: [] });
  }
  source.updateCarbonStrategies({ upserts: [], removed: [strategy(3)] });
  source.updateCarbonStrategies({ upserts: [strategy(3)], removed: [] });
  const delta = source.takeChanges();
  expect(delta.carbon?.kind).toBe('delta');
  if (delta.carbon?.kind !== 'delta') throw new Error('expected delta');
  expect(delta.carbon.upserts).toHaveLength(2);
  expect(delta.carbon.removed).toEqual([]);
  mirror.applyChanges(delta);
  equivalent(mirror, source);
  source.updateCarbonStrategies({ upserts: [strategy(4)], removed: [strategy(2)] });
  source.takeChanges(); // Simulate a failed worker job draining its journal.
  source.updateCarbonStrategies({ upserts: [], removed: [strategy(3)] });
  const restarted = new MarketGraph(policy);
  restarted.applyChanges(structuredClone(source.takeChanges(true)));
  equivalent(restarted, source);
  source.setCarbonStrategies([]);
  mirror.applyChanges(source.takeChanges());
  expect(active(mirror)).toEqual([]);
});

test('raw native/wrapped pairs and controller-scoped IDs remain separate', () => {
  const graph = new MarketGraph(policy);
  const native = [strategy(1, NATIVE_TOKEN), strategy(2, NATIVE_TOKEN)];
  const wrapped = [strategy(3, WRAPPED_NATIVE), strategy(4, WRAPPED_NATIVE)];
  const other = { ...strategy(1), controller: address(20) };
  graph.setCarbonStrategies([...native, ...wrapped, other]);
  graph.updateCarbonStrategies({ upserts: [], removed: [native[0]] });
  expect(graph.edge(`carbon-group:${controller}:${NATIVE_TOKEN.toLowerCase()}:${address(3)}`)?.liquidity).toBe(0n);
  expect(graph.edge(`carbon-group:${controller}:${WRAPPED_NATIVE.toLowerCase()}:${address(3)}`)?.liquidity).toBe(2000n);
  expect(graph.edge(`${carbonStrategyKey(other)}:1`)?.liquidity).toBe(1000n);
  const rebuilt = new MarketGraph(policy);
  rebuilt.setCarbonStrategies([native[1], ...wrapped, other]);
  equivalent(graph, rebuilt);
});

test('snapshot replacement repairs token indexes and disables old pair groups', () => {
  const graph = new MarketGraph(policy);
  graph.setCarbonStrategies([strategy(1), strategy(2)]);
  const replacement = [strategy(1, address(10), address(11)), strategy(2, address(10), address(11))];
  graph.setCarbonStrategies(replacement);
  const rebuilt = new MarketGraph(policy);
  rebuilt.setCarbonStrategies(replacement);
  equivalent(graph, rebuilt);
  expect(graph.rankedEdges(address(2), 100)).toEqual([]);
});

test('mixed curved-order batches stay equivalent to rebuilds across multiple pairs', () => {
  const source = new MarketGraph(policy);
  const mirror = new MarketGraph(policy);
  const catalog = new Map<string, CarbonStrategy>();
  let seed = 12345;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed >>> 8;
  };
  for (let batch = 0; batch < 60; batch++) {
    const upserts: CarbonStrategy[] = [];
    const removed: CarbonStrategy[] = [];
    for (let j = 0; j < 4; j++) {
      const id = next() % 24;
      const pair = Math.floor(id / 6);
      const s = strategy(id, address(100 + pair * 2), address(101 + pair * 2));
      if (id % 2) [s.token0, s.token1] = [s.token1, s.token0];
      s.orders = [0, 1].map(() => ({ y: BigInt(next() % 1000), z: 1000n, A: 1n << 45n, B: 1n << 47n })) as CarbonStrategy['orders'];
      if (next() % 3 === 0) removed.push(s);
      else upserts.push(s);
    }
    for (const s of removed) catalog.delete(carbonStrategyKey(s));
    for (const s of upserts) catalog.set(carbonStrategyKey(s), s);
    source.updateCarbonStrategies({ upserts, removed });
    mirror.applyChanges(structuredClone(source.takeChanges()));
    const rebuilt = new MarketGraph(policy);
    rebuilt.setCarbonStrategies([...catalog.values()].reverse());
    equivalent(source, rebuilt);
    equivalent(mirror, rebuilt);
  }
});
