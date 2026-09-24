import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Address } from 'viem';
import { type MarketSnapshot } from '../src/market-db';
import { MarketGraph } from '../src/market-graph/market-graph';
import { type MarketEventContext } from '../src/protocols/protocol-plugin';
import { v2Plugin } from '../src/protocols/v2';
import { V2_FACTORIES } from '../src/protocols/v2/config';
import { discoverV2PoolMetadata } from '../src/protocols/v2/metadata';
import { V2EventAdapter } from '../src/protocols/v2/runtime';
import { V2Store } from '../src/protocols/v2/store';
import { logger } from '../src/reporting/logger';
import { LiveMarketRegistry } from '../src/runtime/live-market-registry';

const address = (value: number) => `0x${value.toString(16).padStart(40, '0')}` as Address;
const hash = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}` as const;

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'v2-runtime-discovery-'));
  const previousPath = process.env.MARKET_DB_PATH;
  process.env.MARKET_DB_PATH = join(directory, 'markets.sqlite');
  const info = spyOn(logger, 'info').mockImplementation(() => {});
  const publish = spyOn(V2EventAdapter.prototype, 'replacePools').mockResolvedValue();
  const pools = spyOn(V2Store.prototype, 'pools');
  const state = { head: 10n, count: 1, secondCount: 0, failSecond: false, reorg: false };
  const ranges: Array<[Address, number, number]> = [];
  const client = {
    getBlockNumber: async () => state.head,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
      number: blockNumber, hash: hash(state.reorg && blockNumber === 10n ? 999n : blockNumber),
    }),
    readContract: async ({ functionName, args }: any) => {
      if (functionName === 'getPairsLength') return V2_FACTORIES.map((_, index) =>
        BigInt(index === 0 ? state.count : index === 1 ? state.secondCount : 0));
      if (functionName === 'getPairsByIndexRange') {
        const [factory, start, stop] = args;
        if (factory === V2_FACTORIES[1].address && state.failSecond) throw new Error('offline read failed');
        ranges.push([factory, Number(start), Number(stop)]);
        return Array.from({ length: Number(stop - start) }, (_, index) => [
          address(1), address(2), address(100 + Number(start) + index + (factory === V2_FACTORIES[1].address ? 100 : 0)),
        ]);
      }
      throw new Error(`Unexpected offline call: ${functionName}`);
    },
  };
  const catalog: MarketSnapshot = { v2Pools: [], v3Pools: [], carbonPairs: [] };
  const registry = new LiveMarketRegistry(catalog, () => {});
  const reconcile = spyOn(registry, 'reconcile');
  const adapters = v2Plugin.events({
    client: client as unknown as MarketEventContext['client'],
    catalog, graph: new MarketGraph(), scan: async () => {}, liveMarkets: registry,
  });
  if (!Array.isArray(adapters)) throw new Error('Missing discovery adapter');
  const discovery = adapters.find(adapter => adapter.id === 'v2-factories')!;
  return {
    state, ranges, catalog, info, pools, publish, reconcile, discovery,
    seed: async () => {
      const store = new V2Store();
      try { await discoverV2PoolMetadata(client, store); }
      finally { store.close(); }
      info.mockClear(); pools.mockClear(); ranges.length = 0;
    },
    cleanup: async () => {
      await discovery.clear();
      reconcile.mockRestore(); pools.mockRestore(); publish.mockRestore(); info.mockRestore();
      if (previousPath === undefined) delete process.env.MARKET_DB_PATH;
      else process.env.MARKET_DB_PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('unchanged V2 runtime checks do not reload, filter or announce the discovery catalog', async () => {
  const f = await fixture();
  try {
    await f.seed();
    await f.discovery.reconcile([]); // One startup reconciliation repairs an interrupted previous run.
    expect(f.info).not.toHaveBeenCalled();
    expect(f.pools).toHaveBeenCalledTimes(1);
    f.info.mockClear(); f.pools.mockClear(); f.reconcile.mockClear(); f.publish.mockClear();
    f.state.head++;
    await f.discovery.apply([]);
    await f.discovery.reconcile([]);
    expect(f.ranges).toEqual([]);
    expect(f.info).not.toHaveBeenCalled();
    expect(f.pools).not.toHaveBeenCalled();
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  } finally { await f.cleanup(); }
});

test('V2 runtime fetches only new indexes and refilters previously ineligible pools', async () => {
  const f = await fixture();
  try {
    await f.seed();
    await f.discovery.reconcile([]);
    expect(f.catalog.v2Pools).toHaveLength(0);
    f.pools.mockClear(); f.reconcile.mockClear();
    f.state.head++; f.state.count = 2;
    await f.discovery.apply([]);
    expect(f.ranges).toEqual([[V2_FACTORIES[0].address, 1, 2]]);
    expect(f.catalog.v2Pools).toHaveLength(2);
    expect(f.pools).toHaveBeenCalledTimes(1);
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    expect(f.info).toHaveBeenCalledWith('V2 discovery updated', { poolsSaved: 1, factoriesReset: 0 });
    await f.discovery.apply([]);
    expect(f.reconcile).toHaveBeenCalledTimes(1);
  } finally { await f.cleanup(); }
});

test('V2 runtime retries reconciliation after discovery already saved its checkpoint', async () => {
  const f = await fixture();
  try {
    await f.seed(); await f.discovery.reconcile([]);
    f.state.head++; f.state.count = 2;
    f.publish.mockRejectedValueOnce(new Error('offline publish failed'));
    await expect(f.discovery.apply([])).rejects.toThrow('offline publish failed');
    f.reconcile.mockClear();
    await f.discovery.apply([]);
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    expect(f.catalog.v2Pools).toHaveLength(2);
    f.reconcile.mockClear();
    await f.discovery.apply([]);
    expect(f.reconcile).not.toHaveBeenCalled();
  } finally { await f.cleanup(); }
});

test('V2 runtime reconciles partial discovery writes after a later factory read fails', async () => {
  const f = await fixture();
  try {
    await f.seed(); await f.discovery.reconcile([]);
    f.state.head++; f.state.count = 2; f.state.secondCount = 1; f.state.failSecond = true;
    await expect(f.discovery.apply([])).rejects.toThrow('offline read failed');
    // The failed factory returns to its old count, leaving no new writes on the retry.
    f.state.secondCount = 0; f.state.failSecond = false;
    f.reconcile.mockClear();
    await f.discovery.apply([]);
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    expect(f.catalog.v2Pools).toHaveLength(2);
  } finally { await f.cleanup(); }
});

test('V2 runtime rebuilds and removes pools after a reorg and pair-count shrink', async () => {
  const f = await fixture();
  try {
    f.state.count = 2;
    await f.seed(); await f.discovery.reconcile([]);
    f.state.head++; f.state.reorg = true;
    await f.discovery.apply([]);
    expect(f.ranges).toEqual([[V2_FACTORIES[0].address, 0, 2]]);
    f.state.head++; f.state.count = 0;
    await f.discovery.apply([]);
    expect(f.catalog.v2Pools).toHaveLength(0);
    f.pools.mockClear();
    await f.discovery.apply([]);
    expect(f.pools).not.toHaveBeenCalled();
  } finally { await f.cleanup(); }
});

test('V2 runtime rebuilds changed factory configuration even when the pair count is unchanged', async () => {
  const f = await fixture();
  try {
    f.state.count = 2;
    await f.seed(); await f.discovery.reconcile([]);
    const store = new V2Store();
    try {
      const factory = V2_FACTORIES[0].address;
      store.saveDiscovery(factory, [], { ...store.checkpoint(factory)!, configuration: 'previous configuration' });
    } finally { store.close(); }
    f.reconcile.mockClear();
    await f.discovery.apply([]);
    expect(f.ranges).toEqual([[V2_FACTORIES[0].address, 0, 2]]);
    expect(f.reconcile).toHaveBeenCalledTimes(1);
    expect(f.catalog.v2Pools).toHaveLength(2);
    f.reconcile.mockClear();
    await f.discovery.apply([]);
    expect(f.reconcile).not.toHaveBeenCalled();
  } finally { await f.cleanup(); }
});
