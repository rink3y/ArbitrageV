import { expect, test } from 'bun:test';
import { RUNTIME } from '../src/constants';
import { ReceiptTracker } from '../src/execution/receipt-tracker';
import { latency } from '../src/runtime/latency';
import { hash } from './helpers/v3-fixture';

test('receipt telemetry retries in the background and stops polling on shutdown', async () => {
  const previous = RUNTIME.receiptPollIntervalMs;
  Object.assign(RUNTIME, { receiptPollIntervalMs: 2 });
  let reads = 0;
  let completed!: () => void;
  const observed = new Promise<void>(resolve => { completed = resolve; });
  const tracker = new ReceiptTracker(async () => {
    if (++reads === 1) throw new Error('not yet mined');
    completed();
    return { status: 'success' };
  });
  try {
    tracker.track(hash(1n), Date.now());
    expect(reads).toBe(0);
    await observed;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(latency.snapshot().counters['receipt.success']).toBeGreaterThan(0);
    tracker.stop();
    tracker.track(hash(2n));
    await Bun.sleep(10);
    expect(reads).toBe(2);
  } finally { tracker.stop(); Object.assign(RUNTIME, { receiptPollIntervalMs: previous }); }
});
