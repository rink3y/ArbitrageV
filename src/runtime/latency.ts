// Bounded samples, no console output or I/O on the measured path.
export class LatencyMetrics {
  private readonly samples = new Map<string, { count: number; values: number[] }>();
  private readonly counters = new Map<string, number>();

  observe(stage: string, milliseconds: number): void {
    const sample = this.samples.get(stage) ?? { count: 0, values: [] };
    sample.values[sample.count++ % 512] = milliseconds;
    this.samples.set(stage, sample);
  }

  increment(name: string, count = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + count);
  }

  snapshot() {
    return {
      counters: Object.fromEntries(this.counters),
      stages: Object.fromEntries([...this.samples].map(([stage, sample]) => {
        const sorted = [...sample.values].sort((a, b) => a - b);
        return [stage, {
          count: sample.count,
          p50Ms: sorted[Math.floor((sorted.length - 1) * 0.5)],
          p95Ms: sorted[Math.floor((sorted.length - 1) * 0.95)],
          maxMs: sorted[sorted.length - 1],
        }];
      })),
    };
  }
}

export const latency = new LatencyMetrics();

// Entries are limited to subscribed market addresses, not individual events.
const receipts = new Map<string, number>();
export function recordMarketReceipt(address: string, receivedAt: number): void {
  receipts.set(address.toLowerCase(), receivedAt);
}
export function marketReceipt(address: string): number | undefined {
  const key = address.startsWith('carbon') ? address.split(':')[1] : address;
  return receipts.get(key.toLowerCase());
}
