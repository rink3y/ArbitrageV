import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { NETWORK } from '../src/constants';
import { loadMarketSnapshot, marketDbPath, replaceMarketSnapshot, updateMarketPools } from '../src/market-db';

import { V2Store, type V2DiscoveryCheckpoint } from '../src/protocols/v2/store';
import { V3Store } from '../src/protocols/v3/store';
import { V3Snapshots } from '../src/protocols/v3/snapshots';
import { address, hash, factory, pool, policy, v3Fixture } from './helpers/v3-fixture';

const token0 = '0x0000000000000000000000000000000000000001' as const;
const token1 = '0x0000000000000000000000000000000000000002' as const;

describe('market catalog', () => {
  test('uses chain-specific defaults and rejects a reused database without modifying its catalog', () => {
    const directory = mkdtempSync(join(tmpdir(), 'arb-chain-'));
    const path = join(directory, 'markets.sqlite');
    const previousChain = NETWORK.chain;
    const previousPath = process.env.MARKET_DB_PATH;
    const original = { v2Pools: [], v3Pools: [], carbonPairs: [{
      controller: token0, token0, token1, strategyCount: 1, feePpm: 4000,
    }] };
    try {
      delete process.env.MARKET_DB_PATH;
      const firstPath = marketDbPath();
      replaceMarketSnapshot(original, path);
      Object.assign(NETWORK, { chain: { ...previousChain, id: previousChain.id + 1 } });
      expect(marketDbPath()).not.toBe(firstPath);
      process.env.MARKET_DB_PATH = path;
      expect(() => loadMarketSnapshot()).toThrow('does not match');
      expect(() => replaceMarketSnapshot({ v2Pools: [], v3Pools: [], carbonPairs: [] })).toThrow('does not match');
      Object.assign(NETWORK, { chain: previousChain });
      expect(loadMarketSnapshot()).toEqual(original);
      const db = new Database(path);
      db.exec('DROP TABLE market_network');
      db.close();
      expect(() => loadMarketSnapshot()).toThrow('no chain identity');
      const legacy = new Database(path, { readonly: true });
      expect(legacy.query('SELECT strategy_count FROM carbon_pairs').get()).toEqual({ strategy_count: 1 });
      legacy.close();
    } finally {
      Object.assign(NETWORK, { chain: previousChain });
      if (previousPath === undefined) delete process.env.MARKET_DB_PATH;
      else process.env.MARKET_DB_PATH = previousPath;
      Bun.gc(true);
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('replaces and loads one domain snapshot', () => {
    const directory = mkdtempSync(join(tmpdir(), 'arb-market-'));
    const path = join(directory, 'markets.sqlite');

    try {
      replaceMarketSnapshot({
        v2Pools: [{
          pairAddress: '0x0000000000000000000000000000000000000010',
          token0,
          token1,
          fee: 30,
          factory: 'test-v2',
          variant: 'solidly-stable',
          scale0: 1_000_000n,
          scale1: 1_000_000n,
        }],
        v3Pools: [{
          name: 'test-v3',
          address: '0x0000000000000000000000000000000000000020',
          token0,
          token1,
          fee: 500,
          tickSpacing: 10,
          enabled: true,
        }],
        carbonPairs: [{
          controller: '0x0000000000000000000000000000000000000030',
          token0,
          token1,
          strategyCount: 2,
          feePpm: 4_000,
        }],
      }, path);

      const snapshot = loadMarketSnapshot(path);
      expect(snapshot.v2Pools).toHaveLength(1);
      expect(snapshot.v3Pools).toHaveLength(1);
      expect(snapshot.carbonPairs).toHaveLength(1);
      expect(snapshot.v2Pools[0].factory).toBe('test-v2');
      expect(snapshot.v2Pools[0].variant).toBe('solidly-stable');
      expect(snapshot.v2Pools[0].scale0).toBe(1_000_000n);
      expect(snapshot.v2Pools[0].scale1).toBe(1_000_000n);
      expect(snapshot.v3Pools[0].tickSpacing).toBe(10);
      expect(snapshot.carbonPairs[0].strategyCount).toBe(2);
      expect(snapshot.carbonPairs[0].feePpm).toBe(4_000);
    } finally {
      Bun.gc(true);
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('rolls back the whole catalog when replacement fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'arb-market-'));
    const path = join(directory, 'markets.sqlite');
    const original = {
      v2Pools: [{
        pairAddress: '0x0000000000000000000000000000000000000010' as const,
        token0, token1, fee: 30, factory: 'test-v2' as const,
        variant: 'uniswap-v2' as const, scale0: 1n, scale1: 1n,
      }],
      v3Pools: [],
      carbonPairs: [{
        controller: '0x0000000000000000000000000000000000000030' as const,
        token0, token1, strategyCount: 2, feePpm: 4_000,
      }],
    };

    try {
      replaceMarketSnapshot(original, path);
      expect(() => replaceMarketSnapshot({
        ...original,
        v2Pools: [original.v2Pools[0], original.v2Pools[0]],
        carbonPairs: [],
      }, path)).toThrow();
      expect(loadMarketSnapshot(path)).toEqual(original);
    } finally {
      Bun.gc(true);
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('updates live pool rows without replacing Carbon metadata', () => {
    const directory = mkdtempSync(join(tmpdir(), 'arb-market-'));
    const path = join(directory, 'markets.sqlite');
    const carbonPairs = [{
      controller: '0x0000000000000000000000000000000000000030' as const,
      token0, token1, strategyCount: 2, feePpm: 4_000,
    }];
    try {
      replaceMarketSnapshot({
        v2Pools: [{ pairAddress: '0x0000000000000000000000000000000000000010', token0, token1,
          fee: 30, factory: 'old', variant: 'uniswap-v2', scale0: 1n, scale1: 1n }],
        v3Pools: [],
        carbonPairs,
      }, path);
      updateMarketPools({
        v2Pools: [],
        v3Pools: [{ name: 'new', address: '0x0000000000000000000000000000000000000020', token0, token1,
          fee: 500, tickSpacing: 10, enabled: true }],
      }, path);
      const snapshot = loadMarketSnapshot(path);
      expect(snapshot.v2Pools).toEqual([]);
      expect(snapshot.v3Pools).toHaveLength(1);
      expect(snapshot.carbonPairs).toEqual(carbonPairs);
    } finally {
      Bun.gc(true);
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

test('V2 discovery and its checkpoint survive catalog replacement and restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'arb-v2-store-'));
  const path = join(directory, 'markets.sqlite');
  const factory = address(900);
  const metadata = {
    pairAddress: address(1), token0: address(100), token1: address(101), factory: 'test',
    fee: 30, variant: 'uniswap-v2' as const, scale0: 1n, scale1: 1n,
  };
  const checkpoint: V2DiscoveryCheckpoint = {
    pairCount: 1, blockNumber: 10n, blockHash: hash(10n), configuration: 'test',
  };
  try {
    const first = new V2Store(path);
    first.saveDiscovery(factory, [metadata], checkpoint);
    first.close();

    replaceMarketSnapshot({ v2Pools: [metadata], v3Pools: [], carbonPairs: [] }, path);
    replaceMarketSnapshot({ v2Pools: [], v3Pools: [], carbonPairs: [] }, path);

    const reopened = new V2Store(path);
    expect(reopened.pools([factory])).toEqual([metadata]);
    expect(reopened.checkpoint(factory)).toEqual(checkpoint);
    reopened.close();
  } finally {
    Bun.gc(true);
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('V3 snapshots and discovery survive catalog replacement and process restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arbitrage-v3-'));
  const path = join(directory, 'markets.sqlite');
  const selected = pool();
  let store = new V3Store(path, 1329);
  try {
    store.saveDiscovery(factory, [{ ...selected, factory, creationBlock: 2n, minWord: -1, maxWord: 0 }], { fromBlock: 0n, blockNumber: 10n, blockHash: hash(10n) });
    await new V3Snapshots(v3Fixture().client, store, policy).load([selected], 10n);
    store.close();
    replaceMarketSnapshot({ v2Pools: [], v3Pools: [selected], carbonPairs: [] }, path);
    expect(loadMarketSnapshot(path).v3Pools).toHaveLength(1);
    replaceMarketSnapshot({ v2Pools: [], v3Pools: [], carbonPairs: [] }, path);
    store = new V3Store(path, 1329);
    expect(store.pools([factory])).toHaveLength(1);
    expect(store.snapshot(selected.address)?.ticks).toHaveLength(2);
    const otherChain = new V3Store(path, 1);
    try {
      expect(otherChain.pools([factory])).toEqual([]);
      expect(otherChain.snapshot(selected.address)).toBeNull();
    } finally { otherChain.close(); }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('incomplete snapshot publication rolls back the whole transaction', async () => {
  const store = new V3Store(':memory:');
  try {
    const selected = pool();
    await new V3Snapshots(v3Fixture().client, store, policy).load([selected], 10n);
    const saved = store.snapshot(selected.address)!;
    expect(() => store.saveSnapshots([{ ...saved, blockNumber: 11n }, { ...saved, complete: false }])).toThrow('incomplete');
    expect(store.snapshot(selected.address)?.blockNumber).toBe(10n);
  } finally { store.close(); }
});
