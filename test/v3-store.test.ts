import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { V3Store } from '../src/protocols/v3/store';
import { V3Snapshots } from '../src/protocols/v3/snapshots';
import { replaceMarketSnapshot, loadMarketSnapshot } from '../src/market-db';
import { factory, pool, policy, v3Fixture, hash } from './helpers/v3-fixture';

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
