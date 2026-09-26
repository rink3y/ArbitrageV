import { RUNTIME } from '../constants';
import { summarizeMetrics } from '../reporting/metrics';

// Bounded samples, no console output or I/O on the measured path.
export class LatencyMetrics {
  private readonly samples = new Map<string, { count: number; values: number[] }>();
  private readonly counters = new Map<string, number>();
  constructor(private readonly active: () => boolean = () => true) {}
  get enabled(): boolean { return this.active(); }
  now(): number { return this.enabled ? performance.now() : 0; }
  elapsed(stage: string, started: number): void { if (this.enabled) this.observe(stage, performance.now() - started); }

  observe(stage: string, milliseconds: number): void {
    if (!this.enabled || !Number.isFinite(milliseconds)) return;
    if (!this.samples.has(stage) && this.samples.size >= 64) return;
    const sample = this.samples.get(stage) ?? { count: 0, values: [] };
    sample.values[sample.count++ % 512] = milliseconds;
    this.samples.set(stage, sample);
  }

  increment(name: string, count = 1): void {
    if (!this.enabled || (!this.counters.has(name) && this.counters.size >= 128)) return;
    this.counters.set(name, (this.counters.get(name) ?? 0) + count);
  }

  raw() {
    return {
      counters: Object.fromEntries(this.counters),
      stages: Object.fromEntries([...this.samples].map(([stage, sample]) => {
        return [stage, { count: sample.count, values: [...sample.values] }];
      })),
    };
  }
  snapshot() { return summarizeMetrics(this.raw()); }
}

export const latency = new LatencyMetrics(() => RUNTIME.logLevel !== 'off');

// Entries are limited to subscribed market addresses, not individual events.
const receipts = new Map<string, number>();
export function recordMarketReceipt(address: string, receivedAt: number): void {
  receipts.set(address.toLowerCase(), receivedAt);
}
export function marketReceipt(address: string): number | undefined {
  const key = address.startsWith('carbon') ? address.split(':')[1] : address;
  return receipts.get(key.toLowerCase());
}
