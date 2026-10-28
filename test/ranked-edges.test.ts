import { afterEach, expect, test } from 'bun:test';
import { type Address } from 'viem';
import { MarketGraph } from '../src/market-graph/market-graph';
import { V2_LIVE_POLICY } from '../src/protocols/v2/config';
import { type PairInfo } from '../src/protocols/v2/types';
import { type CarbonStrategy } from '../src/protocols/carbon/types';
import { type MarketProtocol } from '../src/market-graph/types';
import { ARBITRAGE_SEARCH_POLICY } from '../src/constants';

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const hub = addr(1);
const transferFees = V2_LIVE_POLICY.transferFees;
afterEach(() => { Object.assign(V2_LIVE_POLICY, { transferFees }); });

function pair(id: number, reserve0: bigint, reserve1: bigint): PairInfo {
  return { pairAddress: addr(1000 + id), token0: hub, token1: addr(100 + id % 7), reserve0, reserve1,
    fee: 30, variant: 'uniswap-v2', scale0: 1n, scale1: 1n };
}

function rebuild(pairs: PairInfo[], removed: Set<number>): MarketGraph {
  const graph = new MarketGraph();
  for (const p of pairs) graph.addPair({ ...p, reserve0: 1_000n, reserve1: 1_000n });
  pairs.forEach((p, id) => {
    if (removed.has(id)) graph.removePair(p.pairAddress);
    else graph.updateReserves([{ pairAddress: p.pairAddress, reserve0: p.reserve0, reserve1: p.reserve1 }]);
  });
  return graph;
}

const rankedIds = (graph: MarketGraph, limit: number) =>
  graph.rankedEdgeIndexes(graph.tokenIndexOf(hub)!, limit).map(index => `${graph.edgeAt(index)!.poolAddress}:${graph.edgeAt(index)!.direction}`);

test('incremental edge ranking matches a full rebuild through updates, ties, removals and new pools', () => {
  Object.assign(V2_LIVE_POLICY, { transferFees: false });
  let seed = 7;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 8;
  const reserve = () => [0n, 500n, 1_000n, 1_000n, 2_000n, 5_000n][next() % 6];
  const pairs = Array.from({ length: 40 }, (_, id) => pair(id, 1_000n, reserve() || 1_000n));
  const removed = new Set<number>();
  const graph = rebuild(pairs, removed);
  for (const limit of [3, 8, 30, 60]) rankedIds(graph, limit);

  for (let step = 0; step < 400; step++) {
    const roll = next() % 10;
    if (roll === 0) {
      pairs.push(pair(pairs.length, reserve() || 1_000n, reserve() || 1_000n));
      graph.addPair({ ...pairs[pairs.length - 1] });
    } else if (roll === 1) {
      const id = next() % pairs.length;
      removed.add(id);
      graph.removePair(pairs[id].pairAddress);
    } else {
      const id = next() % pairs.length;
      if (removed.has(id)) continue;
      pairs[id] = { ...pairs[id], reserve0: reserve(), reserve1: reserve() };
      graph.updateReserves([{ pairAddress: pairs[id].pairAddress, reserve0: pairs[id].reserve0, reserve1: pairs[id].reserve1 }]);
    }
    const expected = rebuild(pairs, removed);
    for (const limit of [3, 8, 30, 60]) expect(rankedIds(graph, limit)).toEqual(rankedIds(expected, limit));
  }
});

test('a small bounded cache stays exact while its spare entries are demoted and removed', () => {
  Object.assign(V2_LIVE_POLICY, { transferFees: false });
  const pairs = Array.from({ length: 200 }, (_, id) => pair(id, 1_000n, BigInt(3_000 - id * 5)));
  const removed = new Set<number>();
  const graph = rebuild(pairs, removed);
  expect(rankedIds(graph, 3)).toEqual(rankedIds(rebuild(pairs, removed), 3));
  for (let step = 0; step < 60; step++) {
    const top = graph.edgeAt(graph.rankedEdgeIndexes(graph.tokenIndexOf(hub)!, 1)[0])!.poolAddress;
    const id = pairs.findIndex(p => p.pairAddress === top);
    if (step % 3 === 0) {
      removed.add(id);
      graph.removePair(pairs[id].pairAddress);
    } else {
      pairs[id] = { ...pairs[id], reserve1: 10n + BigInt(step) };
      graph.updateReserves([{ pairAddress: pairs[id].pairAddress, reserve0: pairs[id].reserve0, reserve1: pairs[id].reserve1 }]);
    }
    expect(rankedIds(graph, 3)).toEqual(rankedIds(rebuild(pairs, removed), 3));
  }
});

test('equal-ranked Carbon and V2 edges keep one order through no-op updates', () => {
  Object.assign(V2_LIVE_POLICY, { transferFees: false });
  const policy = { ...ARBITRAGE_SEARCH_POLICY, allowedProtocols: ['v2', 'carbon'] as MarketProtocol[] };
  const token = addr(2);
  const order = { y: 997_000n, z: 997_000n, A: 0n, B: (1n << 48n) | (1n << 47n) };
  const strategy = (id: number): CarbonStrategy => ({ id: BigInt(id), controller: addr(50), owner: addr(51),
    token0: token, token1: addr(3), feePpm: 30, orders: [order, order] });
  const build = () => {
    const graph = new MarketGraph(policy);
    graph.setCarbonStrategies([strategy(9)]);
    graph.addPair({ pairAddress: addr(60), token0: token, token1: addr(3), reserve0: 997_000n, reserve1: 999_970n,
      fee: 30, variant: 'uniswap-v2', scale0: 1n, scale1: 1n });
    graph.updateCarbonStrategies({ upserts: [strategy(1)], removed: [] });
    return graph;
  };
  const ranked = (graph: MarketGraph) => graph.rankedEdgeIndexes(graph.tokenIndexOf(token)!, 10).map(index => graph.edgeAt(index)!.id);
  const graph = build();
  const before = ranked(graph);
  expect(before.filter(id => !id.startsWith('carbon-group'))).toHaveLength(3);
  graph.updateCarbonStrategies({ upserts: [strategy(1)], removed: [] });
  graph.updateCarbonStrategies({ upserts: [strategy(9)], removed: [] });
  expect(ranked(graph)).toEqual(before);
  expect(ranked(graph)).toEqual(ranked(build()));
});

test('an update outside the cached top edges keeps the cached ranking', () => {
  Object.assign(V2_LIVE_POLICY, { transferFees: false });
  const pairs = Array.from({ length: 30 }, (_, id) => pair(id, 1_000n, BigInt(2_000 - id * 10)));
  const graph = rebuild(pairs, new Set());
  const token = graph.tokenIndexOf(hub)!;
  const ranked = graph.rankedEdgeIndexes(token, 4);
  graph.updateReserves([{ pairAddress: pairs[29].pairAddress, reserve0: 1_000n, reserve1: 1_001n }]);
  expect(graph.rankedEdgeIndexes(token, 4)).toEqual(ranked);
  graph.updateReserves([{ pairAddress: pairs[29].pairAddress, reserve0: 1_000n, reserve1: 5_000n }]);
  expect(graph.edgeAt(graph.rankedEdgeIndexes(token, 4)[0])!.poolAddress).toBe(pairs[29].pairAddress);
});
