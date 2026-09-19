import { expect, test } from 'bun:test';
import { BackgroundQueue } from '../src/runtime/background-queue';
import { LatencyMetrics } from '../src/runtime/latency';

test('background work is deferred, coalesced, bounded, and survives rejection', async () => {
  const queue = new BackgroundQueue(2);
  const ran: number[] = [];
  queue.enqueue('a', () => { ran.push(1); });
  queue.enqueue('a', () => { ran.push(2); });
  queue.enqueue('b', () => { throw new Error('expected'); });
  queue.enqueue('c', () => { ran.push(3); });
  expect(ran).toEqual([]);
  for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
  expect(ran).toEqual([3]);
  queue.stop();
  queue.enqueue('d', () => { ran.push(4); });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(ran).toEqual([3]);
});

test('latency samples are bounded while total counts remain cumulative', () => {
  const metrics = new LatencyMetrics();
  for (let i = 0; i < 1024; i++) metrics.observe('search', i);
  metrics.increment('dropped', 3);
  expect(metrics.snapshot().counters.dropped).toBe(3);
  expect(metrics.snapshot().stages.search).toEqual({ count: 1024, p50Ms: 767, p95Ms: 997, maxMs: 1023 });
});
