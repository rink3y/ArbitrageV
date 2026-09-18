import { type Address, type PublicClient } from 'viem';
import { RUNTIME } from '../../constants';
import { type OpportunityEngine } from '../../opportunities/opportunity-engine';
import { type ProtocolEventAdapter } from '../../runtime/protocol-event-adapter';
import { V3_STARTUP_POLICY } from './config';
import { decodeV3PoolEvent, V3_POOL_EVENT_ABI } from './events';
import { type V3Client } from './query';
import { V3Snapshots, type SnapshotPolicy } from './snapshots';
import { V3Store } from './store';
import { type V3PoolConfig } from './types';

export class V3EventAdapter implements ProtocolEventAdapter {
  readonly id = 'v3';
  // Snapshot checkpoints, including reorg checks, govern V3 event ordering.
  readonly managesOwnCursors = true;
  private readonly pools: Map<string, V3PoolConfig>;
  private readonly snapshots: V3Snapshots;
  private pending: Promise<void> = Promise.resolve();
  private revision = 0;
  private readonly requestedRevision = new Map<string, number>();

  constructor(
    private readonly client: PublicClient<any, any, any>,
    private readonly engine: OpportunityEngine,
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
    const unwatch: Array<() => void> = [];
    const addresses = this.addresses();
    try {
      for (let start = 0; start < addresses.length; start += this.policy.eventAddressBatchSize) {
        unwatch.push(client.watchContractEvent({
          address: addresses.slice(start, start + this.policy.eventAddressBatchSize),
          abi: V3_POOL_EVENT_ABI, strict: true, onLogs, onError,
        }));
      }
      return unwatch;
    } catch (error) {
      for (const stop of unwatch) stop();
      throw error;
    }
  }

  bufferKey(log: any): string | null {
    return log.address && this.owns(log.address) ? log.address.toLowerCase() : null;
  }

  async hydrate(blockNumber?: bigint): Promise<void> {
    await this.synchronize(this.addresses(), blockNumber);
  }

  async reconcile(logs: readonly any[]): Promise<void> {
    await this.reconcileAddresses(logs.map(log => log.address).filter(Boolean));
  }

  async reconcileAddresses(addresses: readonly Address[]): Promise<void> {
    await this.synchronize(addresses);
  }

  async apply(logs: any[]): Promise<void> {
    const addresses = [...new Set<Address>(logs
      .filter(log => log.address && this.owns(log.address) && (log.removed || decodeV3PoolEvent(log)?.kind !== 'collect'))
      .map(log => log.address))];
    if (addresses.length === 0) return;
    await this.synchronize(addresses);
    await this.scan(addresses.map(address => address.toLowerCase()), addresses);
  }

  private synchronize(addresses: readonly Address[], blockNumber?: bigint): Promise<void> {
    const revision = ++this.revision;
    const keys = new Set(addresses.map(address => address.toLowerCase()));
    const requested = [...this.pools].filter(([key]) => keys.has(key)).map(([, pool]) => pool);
    for (const pool of requested) {
      this.requestedRevision.set(pool.address.toLowerCase(), revision);
      this.engine.invalidateV3Pool(pool.address);
    }
    const work = async () => {
      const pools = requested.filter(pool => this.requestedRevision.get(pool.address.toLowerCase()) === revision);
      if (pools.length === 0) return;
      const target = blockNumber ?? await this.client.getBlockNumber({ cacheTime: 0 });
      const result = await this.snapshots.load(pools, target);
      for (const snapshot of result.snapshots) {
        if (this.requestedRevision.get(snapshot.poolAddress.toLowerCase()) !== revision) continue;
        const pool = this.pools.get(snapshot.poolAddress.toLowerCase())!;
        this.engine.replaceV3Snapshot(pool, snapshot);
      }
      for (const address of result.failed) console.warn(`V3 snapshot unavailable for ${address}; pool excluded until a successful refresh`);
      if (RUNTIME.debug) console.log(`V3 ready: ${result.snapshots.length}/${pools.length} pools at block ${target}`);
    };
    const next = this.pending.then(work);
    this.pending = next.catch(() => {});
    return next;
  }
}
