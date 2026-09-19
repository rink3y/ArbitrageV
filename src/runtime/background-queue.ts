import { latency } from './latency';

// Only expendable work belongs here. Never enqueue market deltas or submissions.
export class BackgroundQueue {
  private readonly pending = new Map<string, () => void | Promise<void>>();
  private scheduled = false;
  private stopped = false;

  constructor(private readonly capacity = 128) {}

  enqueue(key: string, work: () => void | Promise<void>): void {
    if (this.stopped) return;
    if (!this.pending.has(key) && this.pending.size >= this.capacity) {
      this.pending.delete(this.pending.keys().next().value!);
      latency.increment('background.dropped');
    }
    this.pending.set(key, work);
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => void this.drain());
  }

  stop(): void { this.stopped = true; this.pending.clear(); }

  private async drain(): Promise<void> {
    const entry = this.pending.entries().next().value;
    if (!entry) { this.scheduled = false; return; }
    this.pending.delete(entry[0]);
    try { await entry[1](); }
    catch { latency.increment('background.failed'); }
    setImmediate(() => void this.drain());
  }
}

export const backgroundLogs = new BackgroundQueue(32);
