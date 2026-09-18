import { afterEach, expect, test } from 'bun:test';
import { CONTRACTS } from '../src/constants';
import { discoverV3Pools } from '../src/protocols/v3/metadata';
import { V3Store } from '../src/protocols/v3/store';
import { factory, pool, v3Fixture, hash } from './helpers/v3-fixture';

const stores: V3Store[] = [];
const queryAddress = CONTRACTS.flashQuery;
afterEach(() => { for (const store of stores.splice(0)) store.close(); Object.assign(CONTRACTS, { flashQuery: queryAddress }); });
const factories = [{ name: 'test', address: factory, fromBlock: 0n, enabled: true }];
const policy = { blockRange: 5n, confirmations: 0n, batchSize: 10 };

function setup() {
  Object.assign(CONTRACTS, { flashQuery: factory });
  const selected = pool();
  const fixture = v3Fixture([selected]);
  fixture.logs.push({ address: factory, blockNumber: 2n, args: { pool: selected.address, token0: selected.token0, token1: selected.token1, fee: selected.fee, tickSpacing: selected.tickSpacing } });
  const store = new V3Store(':memory:');
  stores.push(store);
  return { selected, fixture, store };
}

test('phase one discovers immutable metadata and bounds without reading liquidity or ticks', async () => {
  const { selected, fixture, store } = setup();
  const pools = await discoverV3Pools(fixture.client, store, factories, policy);
  expect(pools).toHaveLength(1);
  expect(pools[0]).toMatchObject({ address: selected.address, creationBlock: 2n, factory, minWord: -1, maxWord: 0 });
  expect(store.checkpoint(factory)?.blockNumber).toBe(10n);
  expect(fixture.calls.filter(call => call.functionName.startsWith('getV3')).map(call => call.functionName)).toEqual(['getV3PoolMetadata']);
  expect(fixture.calls.find(call => call.functionName === 'getV3PoolMetadata').blockNumber).toBe(10n);
});

test('later discovery only scans new blocks and preserves the complete catalog', async () => {
  const { fixture, store } = setup();
  await discoverV3Pools(fixture.client, store, factories, policy);
  fixture.head = 12n;
  fixture.calls.length = 0;
  expect(await discoverV3Pools(fixture.client, store, factories, policy)).toHaveLength(1);
  expect(fixture.calls.find(call => call.functionName === 'getLogs').fromBlock).toBe(11n);
  expect(fixture.calls.some(call => call.functionName === 'getV3PoolMetadata')).toBe(false);
  expect(await discoverV3Pools(fixture.client, store, [], policy)).toEqual([]);
  expect(store.pools([factory])).toHaveLength(1);
});

test('failed metadata reads never advance the discovery checkpoint past unprocessed pools', async () => {
  const { fixture, store } = setup();
  fixture.failure = call => call.functionName === 'getV3PoolMetadata';
  await expect(discoverV3Pools(fixture.client, store, factories, policy)).rejects.toThrow();
  expect(store.checkpoint(factory)).toBeNull();
  expect(store.pools([factory])).toEqual([]);
});

test('a discovery reorg removes orphaned pools and rescans the factory', async () => {
  const { fixture, store } = setup();
  await discoverV3Pools(fixture.client, store, factories, policy);
  fixture.hashes.set(10n, hash(1000n));
  fixture.logs.length = 0;
  expect(await discoverV3Pools(fixture.client, store, factories, policy)).toEqual([]);
  expect(store.checkpoint(factory)?.blockHash).toBe(hash(1000n));
});

test('rejects metadata that disagrees with the factory event', async () => {
  const { fixture, store } = setup();
  fixture.logs[0].args.fee = 500;
  await expect(discoverV3Pools(fixture.client, store, factories, policy)).rejects.toThrow('does not match');
  expect(store.checkpoint(factory)).toBeNull();
});
