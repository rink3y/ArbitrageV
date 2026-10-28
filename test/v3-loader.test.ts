import { afterEach, expect, test } from 'bun:test';
import { V3Snapshots } from '../src/protocols/v3/snapshots';
import { V3Store } from '../src/protocols/v3/store';
import { tickWordBounds, validateSnapshot } from '../src/protocols/v3/coverage';
import { pool, policy, v3Fixture, liquidityLog, swapLog, hash } from './helpers/v3-fixture';

const stores: V3Store[] = [];
function store() { const db = new V3Store(':memory:'); stores.push(db); return db; }
afterEach(() => { for (const db of stores.splice(0)) db.close(); });

test('loads all bitmap words and ticks at one block, including empty coverage', async () => {
  const selected = pool(1, 60);
  const fixture = v3Fixture([selected]);
  const db = store();
  const loader = new V3Snapshots(fixture.client, db, { ...policy, bitmapWordsPerPage: 8 });
  const result = await loader.load([selected], 10n);
  expect(result.failed).toEqual([]);
  const snapshot = db.snapshot(selected.address)!;
  expect(snapshot.complete).toBe(true);
  expect(snapshot.ticks).toHaveLength(2);
  expect(snapshot.bitmapWords).toHaveLength(2);
  expect(snapshot.minWord).toBe(tickWordBounds(60).minWord);
  const requests = fixture.calls.filter(call => call.functionName === 'getV3TickBitmapWords').flatMap(call => call.args[0]);
  expect(requests[0].startWord).toBe(snapshot.minWord);
  const last = requests.at(-1);
  expect(last.startWord + last.wordCount - 1).toBe(snapshot.maxWord);
  expect(fixture.calls.filter(call => call.functionName !== 'getLogs').every(call => call.blockNumber === 10n)).toBe(true);
  expect(db.draft(selected.address)).toBeNull();
  validateSnapshot(snapshot, 60);
});

test('saved snapshots catch up swaps without downloading tick ranges again', async () => {
  const selected = pool();
  const fixture = v3Fixture();
  const db = store();
  await new V3Snapshots(fixture.client, db, policy).load([selected], 10n);
  fixture.calls.length = 0;
  fixture.logs.push(swapLog(selected, 11n));
  fixture.price += 10n;
  const result = await new V3Snapshots(fixture.client, db, policy).load([selected], 12n);
  expect(result.failed).toEqual([]);
  expect(result.snapshots[0].sqrtPriceX96).toBe(fixture.price);
  expect(result.snapshots[0].blockNumber).toBe(12n);
  expect(fixture.calls.some(call => call.functionName === 'getV3TickBitmapWords' || call.functionName === 'getV3Ticks')).toBe(false);
  expect(fixture.calls.find(call => call.functionName === 'getLogs').fromBlock).toBe(11n);
});

test('cold starts batch live states across pools', async () => {
  const pools = [pool(1), pool(2), pool(3)];
  const fixture = v3Fixture(pools);
  const result = await new V3Snapshots(fixture.client, store(), policy).load(pools, 10n);
  expect(result.snapshots).toHaveLength(3);
  expect(fixture.calls.filter(call => call.functionName === 'getV3LiveStates').map(call => call.args[0].length)).toEqual([2, 1]);
});

test('Sailor swap events refresh the saved live state', async () => {
  const selected = pool();
  const fixture = v3Fixture();
  const db = store();
  const loader = new V3Snapshots(fixture.client, db, policy);
  await loader.load([selected], 10n);
  fixture.logs.push(swapLog(selected, 11n, true));
  fixture.price += 100n;
  const result = await loader.load([selected], 11n);
  expect(result.failed).toEqual([]);
  expect(result.snapshots[0].sqrtPriceX96).toBe(fixture.price);
});

test('offline burns remove ticks and bitmap bits rather than retaining stale liquidity', async () => {
  const selected = pool();
  const fixture = v3Fixture();
  const db = store();
  const loader = new V3Snapshots(fixture.client, db, policy);
  await loader.load([selected], 10n);
  fixture.logs.push(liquidityLog(selected, 'Burn', 11n));
  fixture.ticks.set(selected.address, []);
  fixture.liquidity = 0n;
  const result = await loader.load([selected], 12n);
  expect(result.snapshots[0].ticks).toEqual([]);
  expect(result.snapshots[0].bitmapWords).toEqual([]);
  expect(result.snapshots[0].liquidity).toBe(0n);
  expect(db.snapshot(selected.address)?.blockNumber).toBe(12n);
});

test('interrupted downloads resume completed pages at the original block', async () => {
  const selected = pool();
  const fixture = v3Fixture();
  const db = store();
  const loader = new V3Snapshots(fixture.client, db, { ...policy, batchSize: 1 });
  fixture.failure = call => call.functionName === 'getV3TickBitmapWords' && call.args[0][0].startWord === 0;
  expect((await loader.load([selected], 10n)).failed).toEqual([selected.address]);
  expect(db.snapshot(selected.address)).toBeNull();
  expect(db.draft(selected.address)?.nextWord).toBe(0);
  fixture.failure = () => false;
  fixture.calls.length = 0;
  const result = await loader.load([selected], 12n);
  expect(result.failed).toEqual([]);
  const firstRead = fixture.calls.find(call => call.functionName === 'getV3TickBitmapWords');
  expect(firstRead.args[0][0].startWord).toBe(0);
  expect(firstRead.blockNumber).toBe(10n);
  expect(result.snapshots[0].blockNumber).toBe(12n);
});

test('a failing pool does not prevent other complete snapshots from loading', async () => {
  const pools = [pool(1), pool(2)];
  const fixture = v3Fixture(pools);
  fixture.failure = call => call.functionName === 'getV3LiveStates' && call.args[0][0] === pools[0].address;
  const result = await new V3Snapshots(fixture.client, store(), policy).load(pools, 10n);
  expect(result.failed).toEqual([pools[0].address]);
  expect(result.snapshots.map(snapshot => snapshot.poolAddress)).toEqual([pools[1].address]);
});

test('reorged snapshots rebuild instead of replaying onto the wrong state', async () => {
  const selected = pool();
  const fixture = v3Fixture();
  const db = store();
  const loader = new V3Snapshots(fixture.client, db, policy);
  await loader.load([selected], 10n);
  fixture.hashes.set(10n, hash(999n));
  fixture.ticks.set(selected.address, []);
  fixture.liquidity = 0n;
  fixture.calls.length = 0;
  const result = await loader.load([selected], 12n);
  expect(result.snapshots[0].ticks).toEqual([]);
  expect(fixture.calls.some(call => call.functionName === 'getV3TickBitmapWords')).toBe(true);
});

test('full-range loading is not capped at 512 initialized ticks', async () => {
  const selected = pool(1, 1);
  const fixture = v3Fixture([selected]);
  fixture.ticks.set(selected.address, Array.from({ length: 600 }, (_, index) => ({ index, liquidityGross: 1n, liquidityNet: index % 2 ? -1n : 1n })));
  fixture.liquidity = 1n;
  const result = await new V3Snapshots(fixture.client, store(), { ...policy, batchSize: 4, bitmapWordsPerPage: 256, ticksPerBatch: 128 }).load([selected], 10n);
  expect(result.failed).toEqual([]);
  expect(result.snapshots[0].ticks).toHaveLength(600);
});

test('coverage validation detects missing ticks even when marked complete', async () => {
  const selected = pool();
  const fixture = v3Fixture();
  const db = store();
  await new V3Snapshots(fixture.client, db, policy).load([selected], 10n);
  const snapshot = db.snapshot(selected.address)!;
  snapshot.ticks.pop();
  expect(() => validateSnapshot(snapshot, selected.tickSpacing)).toThrow('bitmap');
});

test('a complete bitmap must agree with the live liquidity', async () => {
  const selected = pool();
  const fixture = v3Fixture();
  fixture.liquidity = 500n;
  const db = store();
  const result = await new V3Snapshots(fixture.client, db, policy).load([selected], 10n);
  expect(result.failed).toEqual([selected.address]);
  expect(result.snapshots).toEqual([]);
  expect(db.snapshot(selected.address)).toBeNull();
});

test('unavailable historical block headers cause a fresh target-block download', async () => {
  const selected = pool();
  const fixture = v3Fixture();
  const db = store();
  const loader = new V3Snapshots(fixture.client, db, policy);
  await loader.load([selected], 10n);
  const getBlock = fixture.client.getBlock;
  fixture.client.getBlock = (request: any) => {
    if (request.blockNumber === 10n) throw new Error('pruned header');
    return getBlock(request);
  };
  const result = await loader.load([selected], 12n);
  expect(result.failed).toEqual([]);
  expect(result.snapshots[0].blockNumber).toBe(12n);
});

test('pruned draft state is replaced by a fresh download at the target block', async () => {
  const selected = pool();
  const fixture = v3Fixture();
  const db = store();
  const loader = new V3Snapshots(fixture.client, db, { ...policy, batchSize: 1 });
  fixture.failure = call => call.functionName === 'getV3TickBitmapWords' && call.args[0][0].startWord === 0;
  await loader.load([selected], 10n);
  fixture.failure = call => call.blockNumber === 10n;
  const result = await loader.load([selected], 12n);
  expect(result.failed).toEqual([]);
  expect(result.snapshots[0].blockNumber).toBe(12n);
  expect(db.draft(selected.address)).toBeNull();
});

test('unavailable catch-up logs fall back to a complete target-block snapshot', async () => {
  const selected = pool();
  const fixture = v3Fixture();
  const db = store();
  const loader = new V3Snapshots(fixture.client, db, policy);
  await loader.load([selected], 10n);
  fixture.failure = call => call.functionName === 'getLogs';
  fixture.ticks.set(selected.address, []);
  fixture.liquidity = 0n;
  const result = await loader.load([selected], 12n);
  expect(result.failed).toEqual([]);
  expect(result.snapshots[0].blockNumber).toBe(12n);
  expect(result.snapshots[0].ticks).toEqual([]);
});

test('missing bitmap pages cannot become complete or replace the saved snapshot', async () => {
  const selected = pool();
  const fixture = v3Fixture();
  const db = store();
  const loader = new V3Snapshots(fixture.client, db, policy);
  await loader.load([selected], 10n);
  fixture.hashes.set(10n, hash(999n));
  const read = fixture.client.readContract;
  fixture.client.readContract = (request: any) => request.functionName === 'getV3TickBitmapWords'
    ? Promise.resolve(request.args[0].map(() => [])) : read(request);
  const result = await loader.load([selected], 12n);
  expect(result.snapshots).toEqual([]);
  expect(result.failed).toEqual([selected.address]);
  expect(db.snapshot(selected.address)?.blockNumber).toBe(10n);
  expect(db.draft(selected.address)?.complete).toBe(false);
});
