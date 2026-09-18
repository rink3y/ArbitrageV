import { type Address, type PublicClient } from 'viem';
import { RUNTIME } from '../constants';
import { advanceCursor, chainLogBlockNumber, type ChainCursor, compareChainLogs, isLogAfterCursor } from './chain-cursor';
import { type ProtocolEventAdapter } from './protocol-event-adapter';

const MAX_WEBSOCKET_RECONNECT_ATTEMPTS = 9;

type BufferedLog = {
  adapter: ProtocolEventAdapter;
  log: any;
};

export class EventMonitor {
  private readonly client: PublicClient;
  private wsClient?: PublicClient;
  private readonly unwatchFns: Array<() => void | Promise<void>> = [];
  private readonly buffered = new Map<string, BufferedLog>();
  private readonly cursors = new Map<string, ChainCursor>();
  private running = false;
  private buffering = false;
  private usingWebSocket = false;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private firstBufferedBlock: bigint | null = null;
  private lastBufferedBlock: bigint | null = null;
  private bufferedLogCount = 0;
  private hydrationFloor = 0n;

  constructor(
    network: any,
    private readonly adapters: readonly ProtocolEventAdapter[]
  ) {
    this.client = network.client;
    if (RUNTIME.websocketEnabled && network.wsClient) {
      this.wsClient = network.wsClient;
      this.usingWebSocket = true;
    }
  }

  async startBuffering(): Promise<void> {
    this.buffering = true;
    await this.start();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const client = this.usingWebSocket && this.wsClient ? this.wsClient : this.client;
    try {
      for (const adapter of this.adapters) {
        this.unwatchFns.push(...await adapter.watch(
          client,
          logs => this.route(adapter, logs),
          error => this.onError(error)
        ));
      }
      this.reconnectAttempts = 0;
      console.log(`Market event feed started for ${this.adapters.map(adapter => adapter.id).join(', ')}`);
    } catch (error) {
      this.running = false;
      if (!this.usingWebSocket) throw error;
      await this.recover('WebSocket connection failed');
    }
  }

  async activate(hydrationFloor = 0n): Promise<void> {
    if (!this.running || !this.buffering) return;
    if (hydrationFloor > this.hydrationFloor) this.hydrationFloor = hydrationFloor;
    while (this.buffered.size > 0) {
      const entries = [...this.buffered.values()].sort((a, b) => compareChainLogs(a.log, b.log));
      this.buffered.clear();
      const byAdapter = new Map<ProtocolEventAdapter, any[]>();
      for (const entry of entries) {
        if (!entry.adapter.managesOwnCursors && this.isAtOrBelowHydrationFloor(entry.log)) continue;
        const address = entry.log.address as Address | undefined;
        if (address) {
          this.updateCursorForAddress(entry.adapter, address, advanceCursor(undefined, entry.log));
        }
        const logs = byAdapter.get(entry.adapter);
        if (logs) logs.push(entry.log);
        else byAdapter.set(entry.adapter, [entry.log]);
      }
      await Promise.all([...byAdapter].map(([adapter, logs]) => adapter.reconcile(logs)));
    }
    this.buffering = false;
    const range = this.firstBufferedBlock === null
      ? 'no market events arrived during hydration'
      : `${this.bufferedLogCount} events observed across blocks ${this.firstBufferedBlock}-${this.lastBufferedBlock}`;
    console.log(`Market event feed caught up and is now live (${range})`);
  }

  async reconcileMarkets(addresses: readonly Address[]): Promise<bigint> {
    const blockNumber = await this.client.getBlockNumber();
    await Promise.all(this.adapters.map(async adapter => {
      const owned = addresses.filter(address => adapter.owns(address));
      if (owned.length === 0) return;
      await adapter.reconcileAddresses(owned);
      const reconciled = {
        blockNumber,
        transactionIndex: Number.MAX_SAFE_INTEGER,
        logIndex: Number.MAX_SAFE_INTEGER,
      };
      for (const address of owned) this.updateCursorForAddress(adapter, address, reconciled);
    }));
    return blockNumber;
  }

  async stop(): Promise<void> {
    await this.stopInternal(false);
  }

  private async route(adapter: ProtocolEventAdapter, logs: any[]): Promise<void> {
    logs.sort(compareChainLogs);
    if (this.buffering) {
      for (const log of logs) {
        const key = adapter.bufferKey(log);
        if (key) this.keepLatest(adapter, key, log);
      }
      return;
    }
    const fresh = adapter.managesOwnCursors ? logs : this.freshLogs(adapter, logs);
    if (fresh.length > 0) await adapter.apply(fresh);
  }

  private keepLatest(adapter: ProtocolEventAdapter, key: string, log: any): void {
    const block = chainLogBlockNumber(log);
    if (this.firstBufferedBlock === null || block < this.firstBufferedBlock) this.firstBufferedBlock = block;
    if (this.lastBufferedBlock === null || block > this.lastBufferedBlock) this.lastBufferedBlock = block;
    this.bufferedLogCount++;
    const bufferKey = `${adapter.id}:${key}`;
    const previous = this.buffered.get(bufferKey);
    if (!previous || compareChainLogs(previous.log, log) < 0) this.buffered.set(bufferKey, { adapter, log });
  }

  private freshLogs(adapter: ProtocolEventAdapter, logs: any[]): any[] {
    let count = 0;
    for (const log of logs) {
      if (this.isAtOrBelowHydrationFloor(log)) continue;
      const address = log.address as Address | undefined;
      if (!address || !this.updateCursorForAddress(adapter, address, advanceCursor(undefined, log))) continue;
      logs[count++] = log;
    }
    logs.length = count;
    return logs;
  }

  private isAtOrBelowHydrationFloor(log: any): boolean {
    return chainLogBlockNumber(log) <= this.hydrationFloor;
  }

  private updateCursorForAddress(
    adapter: ProtocolEventAdapter,
    address: Address,
    next: ChainCursor
  ): boolean {
    const key = `${adapter.id}:${address.toLowerCase()}`;
    const cursor = this.cursors.get(key);
    if (cursor && !isLogAfterCursor(next, cursor)) return false;
    this.cursors.set(key, next);
    return true;
  }

  private async stopInternal(preserveCursors: boolean): Promise<void> {
    if (!this.running) return;
    this.running = false;
    for (const unwatch of this.unwatchFns) {
      try { await unwatch(); } catch (error) { console.error('Error unsubscribing from market events:', error); }
    }
    this.unwatchFns.length = 0;
    this.buffered.clear();
    this.firstBufferedBlock = null;
    this.lastBufferedBlock = null;
    this.bufferedLogCount = 0;
    for (const adapter of this.adapters) adapter.clear?.();
    if (!preserveCursors) {
      this.cursors.clear();
      this.hydrationFloor = 0n;
    }
  }

  private async recover(reason: string): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      this.reconnectAttempts++;
      if (this.reconnectAttempts > MAX_WEBSOCKET_RECONNECT_ATTEMPTS) {
        this.usingWebSocket = false;
        this.wsClient = undefined;
        this.reconnectAttempts = 0;
      } else {
        await new Promise(resolve => setTimeout(resolve, this.reconnectAttempts * 2_000));
      }
      console.log(`${reason}; restarting market event feed`);
      await this.stopInternal(true);
      await this.start();
      await this.reconcileMarkets(this.adapters.flatMap(adapter => adapter.addresses()));
    } finally {
      this.reconnecting = false;
    }
  }

  private async onError(error: any): Promise<void> {
    const message = `${error?.message ?? ''} ${error?.details ?? ''}`.toLowerCase();
    if (this.usingWebSocket && /(websocket|connection|socket|closed)/.test(message)) {
      await this.recover('WebSocket event feed error');
      return;
    }
    if (/(filter not found|invalid parameters|rpc request failed)/.test(message)) {
      await this.recover('RPC event filter error');
    }
  }
}
