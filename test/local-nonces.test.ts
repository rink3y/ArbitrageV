import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { LocalNonces } from '../src/execution/local-nonces';

const allocators: LocalNonces[] = [];
function allocator(read: () => Promise<number>, refresh = 43_200_000, retry = 5_000) {
  const result = new LocalNonces(read, refresh, retry);
  allocators.push(result);
  return result;
}

afterEach(() => {
  for (const nonces of allocators.splice(0)) nonces.stop();
  mock.restore();
});

test('warms once, coalesces startup reads, and allocates locally', async () => {
  const read = mock(async () => 7);
  const nonces = allocator(read);
  expect(() => nonces.reserve()).toThrow('not been warmed');
  await Promise.all([nonces.start(), nonces.start()]);
  expect(Array.from({ length: 100 }, () => nonces.reserve())).toEqual(
    Array.from({ length: 100 }, (_, i) => i + 7),
  );
  await nonces.start();
  expect(read).toHaveBeenCalledTimes(1);
});

test('a slow refresh never rolls back reservations or blocks the normal path', async () => {
  let resolve!: (value: number) => void;
  const read = mock(() => Promise.resolve(7));
  const nonces = allocator(read);
  await nonces.start();
  expect(nonces.reserve()).toBe(7);
  read.mockImplementation(() => new Promise<number>(done => { resolve = done; }));
  const refresh = nonces.refresh();
  expect(nonces.refresh()).toBe(refresh);
  await Promise.resolve();
  expect(nonces.reserve()).toBe(8);
  expect(nonces.reserve()).toBe(9);
  resolve(6);
  await refresh;
  expect(nonces.reserve()).toBe(10);
  read.mockImplementation(async () => 20);
  await nonces.refresh();
  expect(nonces.reserve()).toBe(20);
});

test('an uncertain submission pauses allocation until pending advances past it', async () => {
  spyOn(console, 'error').mockImplementation(() => {});
  let pending = 7;
  const read = mock(async () => pending);
  const nonces = allocator(read);
  await nonces.start();
  const failed = nonces.reserve();
  expect(nonces.reserve()).toBe(8); // Another submission was already in flight.
  nonces.submissionFailed(failed);
  expect(() => nonces.reserve()).toThrow('paused');
  await nonces.refresh();
  expect(read).toHaveBeenCalledTimes(2);
  expect(() => nonces.reserve()).toThrow('paused');
  pending = 8;
  await nonces.refresh();
  expect(nonces.reserve()).toBe(9); // Never reuse either reservation.
});

test('every uncertain nonce must be reconciled before allocation resumes', async () => {
  spyOn(console, 'error').mockImplementation(() => {});
  let pending = 7;
  const nonces = allocator(async () => pending);
  await nonces.start();
  const first = nonces.reserve();
  const second = nonces.reserve();
  nonces.submissionFailed(first);
  nonces.submissionFailed(second);
  pending = 8;
  await nonces.refresh();
  expect(() => nonces.reserve()).toThrow('paused');
  pending = 9;
  await nonces.refresh();
  expect(nonces.reserve()).toBe(9);
});

test('failed periodic reads preserve the local counter; failed recovery stays paused', async () => {
  spyOn(console, 'error').mockImplementation(() => {});
  const read = mock(async () => 7);
  const nonces = allocator(read);
  await nonces.start();
  read.mockImplementation(async () => { throw new Error('offline'); });
  await expect(nonces.refresh()).rejects.toThrow('offline');
  expect(nonces.reserve()).toBe(7);
  nonces.submissionFailed(7);
  await expect(nonces.refresh()).rejects.toThrow('offline');
  expect(() => nonces.reserve()).toThrow('paused');
});

test('startup read failures are retryable and invalid pending values are rejected', async () => {
  const read = mock(async () => -1);
  const nonces = allocator(read);
  await expect(nonces.start()).rejects.toThrow('Invalid pending nonce');
  expect(() => nonces.reserve()).toThrow('not been warmed');
  read.mockImplementation(async () => 12);
  await nonces.start();
  expect(nonces.reserve()).toBe(12);
});

test('refresh runs on its configured interval and stops on shutdown', async () => {
  let refreshed!: () => void;
  const secondRead = new Promise<void>(resolve => { refreshed = resolve; });
  let reads = 0;
  const nonces = allocator(async () => {
    if (++reads === 2) refreshed();
    return 7;
  }, 20);
  await nonces.start();
  await secondRead;
  nonces.stop();
  await Bun.sleep(50);
  expect(reads).toBe(2);
  expect(() => nonces.reserve()).toThrow('stopped');
  await expect(nonces.start()).rejects.toThrow('stopped');
});

test('uncertain submissions retry on the short interval, not the 12-hour interval', async () => {
  spyOn(console, 'error').mockImplementation(() => {});
  let retried!: () => void;
  const retry = new Promise<void>(resolve => { retried = resolve; });
  let reads = 0;
  const nonces = allocator(async () => {
    reads++;
    if (reads === 3) retried();
    return reads >= 3 ? 8 : 7;
  }, 43_200_000, 20);
  await nonces.start();
  nonces.submissionFailed(nonces.reserve());
  await retry;
  await nonces.refresh();
  expect(nonces.reserve()).toBe(8);
});

test('invalid intervals fail rather than turning into a tight timer loop', () => {
  for (const interval of [0, -1, Infinity, 0.5, 2_147_483_648]) {
    expect(() => new LocalNonces(async () => 0, interval, 5_000)).toThrow('intervals');
    expect(() => new LocalNonces(async () => 0, 43_200_000, interval)).toThrow('intervals');
  }
});
