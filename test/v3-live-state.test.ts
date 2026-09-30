import { afterEach, expect, test } from 'bun:test';
import { ARBITRAGE_SEARCH_POLICY, CONTRACTS } from '../src/constants';
import { MarketGraph } from '../src/market-graph/market-graph';
import { V3EventAdapter } from '../src/protocols/v3/runtime';
import { V3Store } from '../src/protocols/v3/store';
import { V3_LIVE_POLICY } from '../src/protocols/v3/config';
import { applyV3Event } from '../src/protocols/v3/live-state';
import { validateSnapshot } from '../src/protocols/v3/coverage';
import { getSqrtRatioAtTick } from '../src/protocols/v3/quote';
import { factory, hash, liquidityLog, policy, pool, swapLog, v3Fixture } from './helpers/v3-fixture';

const previousQuery = CONTRACTS.flashQuery;
afterEach(() => Object.assign(CONTRACTS, { flashQuery: previousQuery }));

async function setup() {
  Object.assign(CONTRACTS, { flashQuery: factory });
  const selected = pool();
  const feed = v3Fixture([selected]);
  const graph = new MarketGraph(ARBITRAGE_SEARCH_POLICY);
  const store = new V3Store(':memory:');
  let scans = 0;
  const adapter = new V3EventAdapter(feed.client, graph, [selected], async () => { scans++; }, store, policy);
  await adapter.hydrate(10n);
  return { selected, feed, graph, store, adapter, scans: () => scans,
    close: async () => { await adapter.clear(); store.close(); } };
}

test('mint and full burn update both signed tick boundaries, bitmap, and active liquidity', async () => {
  const f = await setup();
  try {
    const before = f.feed.calls.length;
    await f.adapter.apply([liquidityLog(f.selected, 'Mint', 11n)]);
    expect(f.graph.getV3Pool(f.selected.address)?.state?.liquidity).toBe(2000n);
    const burn = liquidityLog(f.selected, 'Burn', 11n, -f.selected.tickSpacing, f.selected.tickSpacing, 2000n);
    burn.logIndex = 2;
    await f.adapter.apply([burn]);
    const live = f.graph.getV3Pool(f.selected.address)!;
    expect(live.state?.liquidity).toBe(0n);
    expect(live.ticks.size).toBe(0);
    expect(live.bitmapWords.size).toBe(0);
    validateSnapshot({ ...f.store.snapshot(f.selected.address)!, ...live.state!, ticks: [], bitmapWords: [] }, f.selected.tickSpacing);
    expect(f.feed.calls.length).toBe(before);
    expect(f.scans()).toBe(2);
  } finally { await f.close(); }
});

test('out-of-range mint leaves active liquidity unchanged and zero-net initialized ticks survive', async () => {
  const f = await setup();
  try {
    const spacing = f.selected.tickSpacing;
    await f.adapter.apply([liquidityLog(f.selected, 'Mint', 11n, spacing, spacing * 2, 1000n)]);
    const live = f.graph.getV3Pool(f.selected.address)!;
    expect(live.state?.liquidity).toBe(1000n);
    expect(live.ticks.get(spacing)).toEqual({ index: spacing, liquidityGross: 2000n, liquidityNet: 0n });
    validateSnapshot({ ...f.store.snapshot(f.selected.address)!, ...live.state!, ticks: [...live.ticks.values()],
      bitmapWords: [...live.bitmapWords].map(([wordPosition, bitmap]) => ({ wordPosition, bitmap })) }, spacing);
    applyV3Event(f.graph, live, { kind: 'swap', update: { sqrtPriceX96: getSqrtRatioAtTick(spacing), tick: spacing, liquidity: 1000n } });
    applyV3Event(f.graph, live, { kind: 'swap', update: { sqrtPriceX96: getSqrtRatioAtTick(spacing * 2), tick: spacing * 2, liquidity: 0n } });
    expect(live.state?.liquidity).toBe(0n);
  } finally { await f.close(); }
});

test('Sailor swap applies locally and exact duplicate delivery does not invalidate candidates', async () => {
  const f = await setup();
  try {
    const before = f.feed.calls.length;
    const log = swapLog(f.selected, 11n, true);
    await f.adapter.apply([log]);
    const versions = f.graph.marketVersions([f.selected.address]);
    await f.adapter.apply([log]);
    expect(f.graph.matchesVersions(versions)).toBe(true);
    expect(f.scans()).toBe(1);
    expect(f.feed.calls.length).toBe(before);
  } finally { await f.close(); }
});

for (const failure of ['removed', 'hash', 'order', 'liquidity', 'missing-cursor'] as const) {
  test(failure + ' invalidates the pool before background recovery', async () => {
    const f = await setup();
    try {
      await f.adapter.apply([swapLog(f.selected, 11n)]);
      const version = f.graph.marketVersions([f.selected.address]);
      const log: any = swapLog(f.selected, 12n, false, failure === 'liquidity' ? 9n : 1000n);
      if (failure === 'removed') log.removed = true;
      if (failure === 'hash') { log.blockNumber = 11n; log.blockHash = hash(999n); }
      if (failure === 'order') { log.blockNumber = 11n; log.blockHash = hash(11n); log.logIndex = 0; }
      if (failure === 'missing-cursor') log.logIndex = null;
      await f.adapter.apply([log]);
      expect(f.graph.getV3Pool(f.selected.address)?.fullRange).toBe(false);
      expect(f.graph.matchesVersions(version)).toBe(false);
      f.feed.head = 12n;
      await f.adapter.reconcileAddresses([f.selected.address]);
      // The first call may join recovery already pinned to the old RPC head.
      await f.adapter.reconcileAddresses([f.selected.address]);
      expect(f.graph.getV3Pool(f.selected.address)?.fullRange).toBe(true);
    } finally { await f.close(); }
  });
}

test('a failed burn validates both boundaries before making any mutation', async () => {
  const f = await setup();
  try {
    const live = f.graph.getV3Pool(f.selected.address)!;
    const ticks = [...live.ticks.values()];
    expect(() => applyV3Event(f.graph, live, { kind: 'liquidity', update: { kind: 'burn', tickLower: -f.selected.tickSpacing,
      tickUpper: 2 * f.selected.tickSpacing, amount: 100n } })).toThrow();
    expect([...live.ticks.values()]).toEqual(ticks);
    expect(live.state?.liquidity).toBe(1000n);
  } finally { await f.close(); }
});

test('events arriving during a checkpoint replay after its block without contaminating the saved snapshot', async () => {
  const f = await setup();
  try {
    f.feed.head = 11n;
    const original = f.feed.client.getLogs;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.feed.client.getLogs = async (args: any) => {
      entered();
      await new Promise<void>(resolve => { release = resolve; });
      return original(args);
    };
    const checkpoint = f.adapter.reconcileAddresses([f.selected.address]);
    await started;
    await f.adapter.apply([liquidityLog(f.selected, 'Mint', 12n)]);
    expect(f.graph.getV3Pool(f.selected.address)?.fullRange).toBe(false);
    release();
    await checkpoint;
    expect(f.graph.getV3Pool(f.selected.address)?.fullRange).toBe(true);
    expect(f.graph.getV3Pool(f.selected.address)?.state?.liquidity).toBe(2000n);
    expect(f.store.snapshot(f.selected.address)?.liquidity).toBe(1000n);
    expect(f.store.snapshot(f.selected.address)?.blockNumber).toBe(11n);
    await f.adapter.apply([liquidityLog(f.selected, 'Mint', 12n)]);
    expect(f.graph.getV3Pool(f.selected.address)?.state?.liquidity).toBe(2000n);
  } finally { await f.close(); }
});

test('a failed checkpoint head read can be retried without stranding the pool', async () => {
  const f = await setup();
  try {
    const original = f.feed.client.getBlockNumber;
    f.feed.client.getBlockNumber = async () => { throw new Error('offline'); };
    await expect(f.adapter.reconcileAddresses([f.selected.address])).rejects.toThrow('offline');
    f.feed.client.getBlockNumber = original;
    await f.adapter.reconcileAddresses([f.selected.address]);
    expect(f.graph.getV3Pool(f.selected.address)?.fullRange).toBe(true);
  } finally { await f.close(); }
});

test('recovery buffer overflow leaves the pool unavailable until a newer snapshot', async () => {
  const f = await setup();
  try {
    f.feed.head = 11n;
    const original = f.feed.client.getLogs;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.feed.client.getLogs = async (args: any) => {
      entered();
      await new Promise<void>(resolve => { release = resolve; });
      return original(args);
    };
    const checkpoint = f.adapter.reconcileAddresses([f.selected.address]);
    await started;
    await f.adapter.apply(Array.from({ length: V3_LIVE_POLICY.recoveryLogsPerPool + 1 }, (_, logIndex) => ({ ...swapLog(f.selected, 12n), logIndex })));
    release();
    await checkpoint;
    expect(f.graph.getV3Pool(f.selected.address)?.fullRange).toBe(false);
    f.feed.client.getLogs = original;
    f.feed.head = 12n;
    await f.adapter.reconcileAddresses([f.selected.address]);
    expect(f.graph.getV3Pool(f.selected.address)?.fullRange).toBe(true);
  } finally { await f.close(); }
});
