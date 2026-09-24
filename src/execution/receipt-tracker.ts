import { type Hex } from 'viem';
import { RUNTIME } from '../constants';
import { latency } from '../runtime/latency';
import { logger } from '../reporting/logger';

// Receipt observation is background telemetry, not part of trade submission.
// Polling measures an upper bound on inclusion latency, not exact block arrival.
export class ReceiptTracker {
  private readonly pending = new Map<Hex, { sentAt: number; eventAt?: number }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private readonly read: (hash: Hex) => Promise<{ status: string }>) {}

  track(hash: Hex, eventAt?: number): void {
    if (this.stopped) return;
    if (this.pending.size >= 128) {
      this.pending.delete(this.pending.keys().next().value!);
      latency.increment('receipt.dropped');
    }
    this.pending.set(hash, { sentAt: Date.now(), eventAt });
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.pending.clear();
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(): void {
    if (this.stopped || this.timer || !this.pending.size) return;
    this.timer = setTimeout(() => void this.poll(), RUNTIME.receiptPollIntervalMs);
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    const batch = [...this.pending].slice(0, 8);
    await Promise.all(batch.map(async ([hash, timing]) => {
      this.pending.delete(hash);
      if (Date.now() - timing.sentAt > RUNTIME.receiptTimeoutMs) {
        latency.increment('receipt.timedOut');
        logger.alert(`receipt.timeout:${hash}`, 'warn', 'Receipt timeout; transaction outcome unknown', { hash });
        return;
      }
      try {
        const receipt = await this.read(hash);
        if (this.stopped) return;
        latency.increment('receipt.' + (receipt.status === 'success' ? 'success' : 'reverted'));
        logger.alert(`receipt:${hash}`, receipt.status === 'success' ? 'info' : 'error',
          receipt.status === 'success' ? 'Transaction confirmed; realized profit not measured' : 'Transaction reverted', { hash });
        if (latency.enabled) {
          latency.observe('submissionAck.toReceiptObserved', Date.now() - timing.sentAt);
          if (timing.eventAt !== undefined) latency.observe('event.toReceiptObserved', Date.now() - timing.eventAt);
        }
      } catch {
        // A missing receipt or a temporary RPC failure is retried, with a deadline.
        if (!this.stopped && this.pending.size < 128) this.pending.set(hash, timing);
      }
    }));
    this.timer = undefined;
    this.schedule();
  }
}
