import { type Address, type PublicClient } from 'viem';
import { logger } from '../reporting/logger';
import { type ProtocolEventAdapter } from './protocol-event-adapter';

type Subscribe = (
  client: PublicClient,
  addresses: readonly Address[],
  onLogs: (logs: any[]) => void | Promise<void>,
  onError: (error: any) => void | Promise<void>
) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;

export class FactoryDiscoveryAdapter implements ProtocolEventAdapter {
  readonly managesOwnCursors = true;
  private work: Promise<void> | undefined;
  private rerun = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly id: string,
    private readonly factories: readonly Address[],
    private readonly subscribe: Subscribe,
    private readonly refresh: () => Promise<void>,
    private readonly intervalMs: number
  ) {}

  addresses(): readonly Address[] { return this.factories; }
  owns(address: Address): boolean { return this.factories.some(factory => factory.toLowerCase() === address.toLowerCase()); }

  async watch(client: PublicClient, onLogs: (logs: any[]) => void | Promise<void>, onError: (error: any) => void | Promise<void>) {
    this.stopped = false;
    const stop = this.factories.length > 0
      ? await this.subscribe(client, this.factories, onLogs, onError)
      : undefined;
    try {
      await this.requestRefresh();
      this.schedule();
      return stop ? [stop] : [];
    } catch (error) {
      await stop?.();
      throw error;
    }
  }

  bufferKey(log: any): string | null {
    return log.address && this.owns(log.address) ? log.address.toLowerCase() : null;
  }

  reconcile(_logs: readonly any[]): Promise<void> { return this.requestRefresh(); }
  reconcileAddresses(_addresses: readonly Address[]): Promise<void> { return this.requestRefresh(); }
  apply(_logs: any[]): Promise<void> { return this.requestRefresh(); }

  async clear(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.work;
  }

  private requestRefresh(): Promise<void> {
    this.rerun = true;
    if (this.work) return this.work;
    this.work = Promise.resolve().then(async () => {
      while (this.rerun && !this.stopped) {
        this.rerun = false;
        await this.refresh();
      }
    }).finally(() => { this.work = undefined; });
    return this.work;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped || this.factories.length === 0 || this.intervalMs <= 0) return;
    this.timer = setTimeout(() => {
      void this.requestRefresh()
        .catch(error => logger.alert(this.id, 'warn', 'Factory discovery failed', this.id, error))
        .finally(() => this.schedule());
    }, this.intervalMs);
    this.timer.unref();
  }
}
