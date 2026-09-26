import { safeArgs, type Lane, type LogLevel, type RecordLevel, type Report } from './records';
import { type MetricSamples } from './metrics';

type Port = { postMessage(message: unknown): void };
const CAPACITY = { logs: 256, alerts: 32 };
const BATCH = 16;

// One outstanding batch per lane. The worker ACKs logs after writing them, so
// postMessage cannot silently become an unbounded second queue.
export class ReportingChannel {
  private queues: Record<Lane, Report[]> = { logs: [], alerts: [] };
  private busy: Record<Lane, boolean> = { logs: false, alerts: false };
  private scheduled = false;
  private stopped = false;
  private recent = new Map<string, number>();
  private dropped = { logs: 0, alerts: 0 };
  private totalDropped = { logs: 0, alerts: 0 };
  failed = false;

  constructor(private readonly port: Port, private readonly level: () => LogLevel,
    private readonly alertsEnabled: boolean, private readonly secrets: readonly string[] = []) {}

  emit(level: RecordLevel, args: readonly unknown[], key?: string): void {
    if (this.stopped) return;
    const enabled = this.level() !== 'off' && (level !== 'debug' || this.level() === 'debug');
    const alert = !!key && this.alertsEnabled;
    if (!enabled && !alert) return;
    // Under sustained debug load, discard before copying/allocating a record.
    if (enabled && level === 'debug' && this.queues.logs.length >= CAPACITY.logs && !alert) {
      this.drop('logs');
      return;
    }
    const at = Date.now();
    const record: Report = { level, at, args: safeArgs(args, this.level() === 'debug' || (alert && level === 'error'), this.secrets), key };
    if (enabled) this.enqueue('logs', record);
    if (alert) {
      const last = this.recent.get(key!);
      if (last === undefined || at - last >= 60_000) {
        if (this.recent.size >= 128) this.recent.delete(this.recent.keys().next().value!);
        this.recent.set(key!, at);
        this.enqueue('alerts', record);
      }
    }
    this.schedule();
  }

  acknowledge(lane: Lane): void { this.busy[lane] = false; this.schedule(); }
  metrics(snapshot: MetricSamples, detail: boolean): void {
    if (this.stopped || this.level() === 'off') return;
    // Internal numeric samples already bounded at collection: 64 stages x 512.
    this.queues.logs = this.queues.logs.filter(record => !record.metrics);
    this.enqueue('logs', { level: 'info', at: Date.now(), args: [], metrics: snapshot, detail });
    this.schedule();
  }
  get idle(): boolean { return !this.busy.logs && !this.busy.alerts && !this.queues.logs.length && !this.queues.alerts.length; }
  get stats() { return { queued: this.queues.logs.length + this.queues.alerts.length,
    inFlight: Number(this.busy.logs) + Number(this.busy.alerts), dropped: { ...this.totalDropped } }; }
  stop(): void { this.stopped = true; this.queues.logs.length = this.queues.alerts.length = 0; this.busy.logs = this.busy.alerts = false; }

  private enqueue(lane: Lane, record: Report): void {
    const queue = this.queues[lane];
    if (queue.length >= CAPACITY[lane]) {
      // Keep critical alerts ahead of routine transaction notifications.
      const disposable = queue.findIndex(item => item.level !== 'error');
      if (disposable < 0 && record.level !== 'error') { this.drop(lane); return; }
      queue.splice(disposable < 0 ? 0 : disposable, 1);
      this.drop(lane);
    }
    if (lane === 'alerts' && record.level === 'error') queue.unshift(record);
    else queue.push(record);
  }
  private drop(lane: Lane): void { this.dropped[lane]++; this.totalDropped[lane]++; }
  private schedule(): void {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (this.stopped) return;
      for (const lane of ['alerts', 'logs'] as const) {
        if (this.busy[lane] || !this.queues[lane].length) continue;
        const records = this.queues[lane].splice(0, BATCH);
        this.busy[lane] = true;
        try {
          this.port.postMessage({ type: 'batch', lane, records, dropped: this.dropped[lane] });
          this.dropped[lane] = 0;
        } catch { this.failed = true; this.stop(); break; } // Reporting must never reject a trade.
      }
    });
  }
}
