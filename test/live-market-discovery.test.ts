import { expect, test } from 'bun:test';
import { encodeAbiParameters, encodeEventTopics, type Address } from 'viem';
import { ARBITRAGE_SEARCH_POLICY, CONTRACTS } from '../src/constants';
import { MarketGraph } from '../src/market-graph/market-graph';
import { type MarketSnapshot } from '../src/market-db';
import { V2_SYNC_EVENT_ABI } from '../src/protocols/v2/events';
import { V2EventAdapter } from '../src/protocols/v2/runtime';
import { type V2PoolMetadata } from '../src/protocols/v2/metadata';
import { V3EventAdapter } from '../src/protocols/v3/runtime';
import { V3Store } from '../src/protocols/v3/store';
import { FactoryDiscoveryAdapter } from '../src/runtime/factory-discovery-adapter';
import { LiveMarketRegistry } from '../src/runtime/live-market-registry';
import { address, factory, policy, pool, v3Fixture } from './helpers/v3-fixture';

const token0 = address(100);
const token1 = address(101);

function v2Pool(id = 1): V2PoolMetadata {
  return {
    pairAddress: address(id), token0, token1, factory: 'test', fee: 30,
    variant: 'uniswap-v2', scale0: 1n, scale1: 1n,
  };
}

test('factory refreshes are serialized and event bursts coalesce into one catch-up', async () => {
  let count = 0;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const adapter = new FactoryDiscoveryAdapter(
    'test-factories', [factory],
    (_client, _addresses, _onLogs, _onError) => () => {},
    async () => {
      count++;
      if (count === 1) { entered(); await blocked; }
    },
    0
  );
  const watching = adapter.watch({} as any, async () => {}, async () => {});
  await started;
  const first = adapter.apply([]);
  const second = adapter.apply([]);
  release();
  const stops = await watching;
  await Promise.all([first, second]);
  expect(count).toBe(2);
  for (const stop of stops) await stop();
  await adapter.clear();
});

test('the live registry applies cross-protocol filtering and republishes removals', async () => {
  const catalog: MarketSnapshot = { v2Pools: [], v3Pools: [], carbonPairs: [] };
  let rawV2 = [v2Pool(1)];
  let rawV3 = [pool(2)];
  const saved: typeof catalog[] = [];
  const publishedV2: V2PoolMetadata[][] = [];
  const publishedV3: Array<typeof rawV3> = [];
  const registry = new LiveMarketRegistry(catalog, snapshot => saved.push(structuredClone(snapshot)));
  registry.registerV2(() => rawV2, async markets => { publishedV2.push([...markets]); });
  registry.registerV3(() => rawV3, async markets => { publishedV3.push([...markets]); });

  await registry.reconcile();
  expect(catalog.v2Pools).toHaveLength(1);
  expect(catalog.v3Pools).toHaveLength(1);
  expect(saved).toHaveLength(1);

  rawV3 = [];
  await registry.reconcile();
  expect(catalog.v2Pools).toEqual([]);
  expect(catalog.v3Pools).toEqual([]);
  expect(publishedV2.at(-1)).toEqual([]);
  expect(publishedV3.at(-1)).toEqual([]);
  expect(saved).toHaveLength(2);
  rawV2 = [];
});

test('a new V2 subscription buffers Sync events until its initial reserves are loaded', async () => {
  const graph = new MarketGraph(ARBITRAGE_SEARCH_POLICY);
  const selected = v2Pool(10);
  let onLogs: ((logs: any[]) => void | Promise<void>) | undefined;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const client = {
    watchContractEvent(options: any) { onLogs = options.onLogs; return () => {}; },
    async getBlockNumber() { return 10n; },
    async readContract() {
      entered();
      await blocked;
      return [[100n, 101n, BigInt(Math.floor(Date.now() / 1000))]];
    },
  };
  const adapter = new V2EventAdapter(client as any, graph, [], async () => {});
  const stops = await adapter.watch(client as any, logs => adapter.apply(logs), async () => {});
  const adding = adapter.replacePools([selected]);
  await started;
  await onLogs!([syncLog(selected.pairAddress, 200n, 201n)]);
  release();
  await adding;
  expect(graph.getAllPairs()[0]).toMatchObject({ pairAddress: selected.pairAddress, reserve0: 200n, reserve1: 201n });

  await adapter.replacePools([]);
  expect(graph.getAllPairs()).toEqual([]);
  for (const stop of stops) await stop();
});

test('a new V3 pool is subscribed, fully hydrated, and removable without a restart', async () => {
  const previousQuery = CONTRACTS.flashQuery;
  Object.assign(CONTRACTS, { flashQuery: factory });
  const first = pool(20);
  const second = pool(21);
  const feed = v3Fixture([first, second]);
  const graph = new MarketGraph(ARBITRAGE_SEARCH_POLICY);
  const store = new V3Store(':memory:');
  const adapter = new V3EventAdapter(feed.client, graph, [first], async () => {}, store, policy);
  try {
    await adapter.hydrate(10n);
    const stops = await adapter.watch(feed.client, logs => adapter.apply(logs), async () => {});
    await adapter.replacePools([first, second]);
    expect(feed.callbacks).toHaveLength(2);
    expect(graph.getV3Pool(second.address)?.fullRange).toBe(true);

    await adapter.replacePools([second]);
    expect(graph.getV3Pool(first.address)).toBeNull();
    for (const stop of stops) await stop();
  } finally {
    await adapter.clear();
    store.close();
    Object.assign(CONTRACTS, { flashQuery: previousQuery });
  }
});

function syncLog(pairAddress: Address, reserve0: bigint, reserve1: bigint) {
  return {
    address: pairAddress,
    blockNumber: 11n,
    blockHash: `0x${'1'.padStart(64, '0')}`,
    transactionIndex: 0,
    logIndex: 0,
    topics: encodeEventTopics({ abi: [V2_SYNC_EVENT_ABI[1]], eventName: 'Sync' }),
    data: encodeAbiParameters([{ type: 'uint112' }, { type: 'uint112' }], [reserve0, reserve1]),
  };
}
