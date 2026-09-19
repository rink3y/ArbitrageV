import { type Address, type PublicClient } from 'viem';
import { type MarketGraph } from '../../market-graph/market-graph';
import { type ProtocolEventAdapter } from '../../runtime/protocol-event-adapter';
import { advanceCursor, compareChainLogs, isLogAfterCursor, type ChainCursor } from '../../runtime/chain-cursor';
import { backgroundLogs } from '../../runtime/background-queue';
import { latency } from '../../runtime/latency';
import { V3_LIVE_POLICY, V3_STARTUP_POLICY } from './config';
import { decodeV3PoolEvent, V3_POOL_EVENT_ABI } from './events';
import { applyV3Event } from './live-state';
import { type V3Client } from './query';
import { V3Snapshots, type SnapshotPolicy } from './snapshots';
import { V3Store } from './store';
import { type V3PoolConfig } from './types';

type PoolCursor = { floor: bigint; last: ChainCursor; hash: string; recent: Map<string, string> };

export class V3EventAdapter implements ProtocolEventAdapter {
  readonly id = 'v3';
  readonly managesOwnCursors = true;
  private readonly pools: Map<string, V3PoolConfig>;
  private readonly snapshots: V3Snapshots;
  private readonly cursors = new Map<string, PoolCursor>();
  private readonly pending = new Set<string>();
  private readonly observed = new Map<string, bigint>();
  private work: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private epoch = 0;
  private checkpointOffset = 0;
  private recoveryScanPending = false;
  private readonly recoveredForScan = new Set<Address>();
  private readonly replay = new Map<string, { floor: bigint; logs: any[] | null }>();

  constructor(
    private readonly client: PublicClient<any, any, any>,
    private readonly graph: MarketGraph,
    pools: readonly V3PoolConfig[],
    private readonly scan: (changedPairs: readonly string[], releasedPairs?: readonly Address[]) => Promise<void>,
    store = new V3Store(),
    private readonly policy: SnapshotPolicy = V3_STARTUP_POLICY
  ) {
    this.pools = new Map(pools.filter(pool => pool.enabled).map(pool => [pool.address.toLowerCase(), pool]));
    this.snapshots = new V3Snapshots(client as unknown as V3Client, store, policy);
  }

  addresses(): readonly Address[] { return [...this.pools.values()].map(pool => pool.address); }
  owns(address: Address): boolean { return this.pools.has(address.toLowerCase()); }

  async watch(client: PublicClient, onLogs: (logs: any[]) => void | Promise<void>, onError: (error: any) => void | Promise<void>) {
    this.stopped = false;
    const unwatch: Array<() => void> = [];
    const addresses = this.addresses();
    try {
      for (let start = 0; start < addresses.length; start += this.policy.eventAddressBatchSize) {
        unwatch.push(client.watchContractEvent({
          address: addresses.slice(start, start + this.policy.eventAddressBatchSize),
          abi: V3_POOL_EVENT_ABI, strict: true, onLogs, onError,
        }));
      }
      this.scheduleCheckpoint();
      return unwatch;
    } catch (error) {
      for (const stop of unwatch) stop();
      throw error;
    }
  }

  bufferKey(log: any): string | null {
    // Startup/reconnect buffers request a block-pinned reload, not delta replay.
    return log.address && this.owns(log.address) ? log.address.toLowerCase() : null;
  }

  hydrate(blockNumber?: bigint): Promise<void> { return this.synchronize(this.addresses(), blockNumber); }
  reconcile(logs: readonly any[]): Promise<void> { return this.reconcileAddresses(logs.map(log => log.address).filter(Boolean)); }
  reconcileAddresses(addresses: readonly Address[]): Promise<void> { return this.synchronize(addresses); }

  async apply(logs: any[]): Promise<void> {
    if (this.stopped) return;
    const started = performance.now();
    const changed = new Set<Address>();
    const recover = new Set<Address>();
    for (const log of [...logs].sort(compareChainLogs)) {
      if (!log.address || !this.owns(log.address)) continue;
      const address = this.pools.get(log.address.toLowerCase())!.address;
      const key = address.toLowerCase();
      if (typeof log.blockNumber === 'bigint') this.observed.set(key, max(this.observed.get(key) ?? 0n, log.blockNumber));
      const replay = this.replay.get(key);
      if (replay) {
        if (replay.logs && replay.logs.length < V3_LIVE_POLICY.recoveryLogsPerPool) replay.logs.push(log);
        else replay.logs = null;
        continue;
      }
      try {
        const cursor = this.cursors.get(key);
        if (!cursor || recover.has(address)) throw new Error('V3 pool needs recovery');
        if (this.applyOrderedLog(log, cursor)) changed.add(address);
      } catch {
        this.graph.invalidateV3Pool(address);
        recover.add(address);
        changed.delete(address);
      }
    }
    latency.observe('v3.apply', performance.now() - started);
    if (recover.size) {
      latency.increment('v3.recovery', recover.size);
      // Healthy pools and log ingestion do not wait for failed-pool RPC recovery.
      const recovery = this.synchronize([...recover]);
      for (const address of recover) this.recoveredForScan.add(address);
      if (!this.recoveryScanPending) {
        this.recoveryScanPending = true;
        void recovery.then(() => {
          this.recoveryScanPending = false;
          const addresses = [...this.recoveredForScan];
          this.recoveredForScan.clear();
          return this.stopped ? undefined : this.scan(addresses, addresses);
        }, error => {
          this.recoveryScanPending = false;
          this.recoveredForScan.clear();
          this.report(error);
        }).catch(error => this.report(error));
      }
    }
    if (changed.size) await this.scan([...changed], [...changed]);
  }

  suspend(): void {
    this.epoch++;
    for (const address of this.addresses()) this.graph.invalidateV3Pool(address);
  }

  async clear(): Promise<void> {
    this.stopped = true;
    this.suspend();
    this.pending.clear();
    this.replay.clear();
    this.recoveredForScan.clear();
    if (this.timer) clearTimeout(this.timer);
    await this.work?.catch(error => this.report(error));
  }

  private synchronize(addresses: readonly Address[], blockNumber?: bigint): Promise<void> {
    if (this.stopped) return Promise.resolve();
    for (const address of addresses) {
      if (!this.owns(address)) continue;
      const key = address.toLowerCase();
      if (this.replay.has(key)) continue;
      this.pending.add(key);
      this.replay.set(key, { floor: this.observed.get(key) ?? 0n, logs: [] });
      this.graph.invalidateV3Pool(address);
    }
    if (this.work) return this.work;
    this.work = Promise.resolve().then(async () => {
      while (this.pending.size && !this.stopped) {
        const keys = [...this.pending].slice(0, this.policy.eventAddressBatchSize);
        for (const key of keys) this.pending.delete(key);
        const epoch = this.epoch;
        try {
          const target = blockNumber ?? await this.client.getBlockNumber({ cacheTime: 0 });
          const result = await this.snapshots.load(keys.map(key => this.pools.get(key)!), target);
          if (this.stopped || epoch !== this.epoch) continue;
          for (const snapshot of result.snapshots) {
            const key = snapshot.poolAddress.toLowerCase();
            const replay = this.replay.get(key);
            // Overflow or an RPC head behind the triggering event requires a
            // newer snapshot. Never throw away deltas and call a pool ready.
            if (!replay?.logs || replay.floor > target) continue;
            const logs = replay.logs;
            this.graph.replaceV3Snapshot(this.pools.get(key)!, snapshot);
            const cursor: PoolCursor = { floor: target, last: { blockNumber: target, transactionIndex: Number.MAX_SAFE_INTEGER, logIndex: Number.MAX_SAFE_INTEGER }, hash: snapshot.blockHash, recent: new Map() };
            this.cursors.set(key, cursor);
            try {
              for (const log of logs.sort(compareChainLogs)) {
                if (log.removed || typeof log.blockNumber !== 'bigint') throw new Error('Untrusted recovery log');
                if (log.blockNumber <= target) {
                  if (log.blockNumber === target && log.blockHash !== snapshot.blockHash) throw new Error('Recovery block changed');
                  continue;
                }
                this.applyOrderedLog(log, cursor);
              }
            } catch {
              this.graph.invalidateV3Pool(snapshot.poolAddress);
            }
          }
          if (result.failed.length) this.report(new Error(result.failed.length + ' V3 pools unavailable; retrying'));
        } finally { for (const key of keys) this.replay.delete(key); }
      }
    }).finally(() => { this.work = undefined; });
    return this.work;
  }

  private applyOrderedLog(log: any, cursor: PoolCursor): boolean {
    if (log.removed || typeof log.blockNumber !== 'bigint' || !/^0x[0-9a-fA-F]{64}$/.test(log.blockHash ?? '') ||
      !Number.isSafeInteger(log.transactionIndex) || !Number.isSafeInteger(log.logIndex) || log.transactionIndex < 0 || log.logIndex < 0) throw new Error('Untrusted V3 cursor');
    if (log.blockNumber < cursor.floor) return false;
    if (log.blockNumber === cursor.last.blockNumber && log.blockHash !== cursor.hash) throw new Error('V3 block changed');
    if (log.blockNumber === cursor.floor) return false;
    const identity = log.blockNumber + ':' + log.transactionIndex + ':' + log.logIndex;
    const fingerprint = log.blockHash + ':' + log.topics.join(',') + ':' + log.data;
    if (cursor.recent.get(identity) === fingerprint) return false;
    if (!isLogAfterCursor(log, cursor.last) || (log.blockNumber === cursor.last.blockNumber && log.blockHash !== cursor.hash)) throw new Error('Recovery ordering mismatch');
    const event = decodeV3PoolEvent(log);
    if (!event) throw new Error('Unknown recovery event');
    applyV3Event(this.graph, this.graph.getV3Pool(log.address)!, event);
    cursor.last = advanceCursor(undefined, log);
    cursor.hash = log.blockHash;
    cursor.recent.set(identity, fingerprint);
    if (cursor.recent.size > V3_LIVE_POLICY.recentLogsPerPool) cursor.recent.delete(cursor.recent.keys().next().value!);
    return event.kind !== 'collect';
  }

  private scheduleCheckpoint(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped || this.pools.size === 0) return;
    const invalid = this.addresses().some(address => !this.graph.getV3Pool(address)?.fullRange);
    this.timer = setTimeout(() => {
      const addresses = this.addresses();
      const selected = Array.from({ length: Math.min(addresses.length, V3_LIVE_POLICY.checkpointPoolsPerBatch) }, (_, i) => addresses[(this.checkpointOffset + i) % addresses.length]);
      this.checkpointOffset = (this.checkpointOffset + selected.length) % addresses.length;
      void this.synchronize(selected).then(() => this.scan(selected, selected)).catch(error => this.report(error)).finally(() => this.scheduleCheckpoint());
    }, invalid ? V3_LIVE_POLICY.retryIntervalMs : V3_LIVE_POLICY.checkpointIntervalMs);
    this.timer.unref();
  }

  private report(error: unknown): void {
    latency.increment('v3.checkpoint.failed');
    backgroundLogs.enqueue('v3-recovery', () => console.warn('V3 recovery:', error));
  }
}

function max(a: bigint, b: bigint) { return a > b ? a : b; }
