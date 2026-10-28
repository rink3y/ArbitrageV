import { type Address } from 'viem';
import { V3_STARTUP_POLICY } from './config';
import { initializedTickIndexes, tickWordBounds, validateSnapshot } from './coverage';
import { decodeV3PoolEvent, V3_POOL_EVENT_ABI } from './events';
import { blockIdentity, queryBatches, readLogs, type V3Client } from './query';
import { V3Store } from './store';
import { type V3BitmapWord, type V3PoolConfig, type V3PoolState, type V3Snapshot, type V3Tick } from './types';

export type SnapshotPolicy = { batchSize: number; bitmapWordsPerPage: number; ticksPerBatch: number; concurrentPools: number; eventAddressBatchSize: number; catchUpBlockRange: bigint };
type LiveResult = V3PoolState & { pool: Address };
type TickResult = { tick: number; liquidityGross: bigint; liquidityNet: bigint; initialized: boolean };
type Identity = { blockNumber: bigint; blockHash: `0x${string}` };

export class V3Snapshots {
  constructor(private readonly client: V3Client, private readonly store: V3Store, private readonly policy: SnapshotPolicy = V3_STARTUP_POLICY) {
    for (const field of ['batchSize', 'bitmapWordsPerPage', 'ticksPerBatch', 'concurrentPools', 'eventAddressBatchSize'] as const) {
      if (!Number.isInteger(policy[field]) || policy[field] < 1) throw new Error(`Invalid V3 ${field}`);
    }
    if (policy.bitmapWordsPerPage > 256 || policy.batchSize * policy.bitmapWordsPerPage > 1024 || policy.ticksPerBatch > 512 || policy.catchUpBlockRange < 1n) throw new Error('V3 snapshot policy exceeds query limits');
  }

  async load(pools: readonly V3PoolConfig[], blockNumber: bigint): Promise<{ snapshots: V3Snapshot[]; failed: Address[] }> {
    const identity = await blockIdentity(this.client, blockNumber);
    const loaded: V3Snapshot[] = [];
    const failed: Address[] = [];
    const initialLive = new Map<string, LiveResult>();
    const fresh = pools.filter(pool => !this.store.snapshot(pool.address) && !this.store.draft(pool.address));
    for (let start = 0; start < fresh.length; start += this.policy.batchSize) {
      const batch = fresh.slice(start, start + this.policy.batchSize);
      try {
        const records = await queryBatches<Address, LiveResult>(this.client, 'getV3LiveStates', batch.map(pool => pool.address), this.policy.batchSize, blockNumber);
        for (let i = 0; i < batch.length; i++) initialLive.set(batch[i].address.toLowerCase(), records[i]);
      } catch {
        // The per-pool download below isolates a reverting pool from its peers.
      }
    }
    const hashes = new Map<bigint, Promise<Identity>>();
    const canonical = (snapshot: Identity) => {
      let promise = hashes.get(snapshot.blockNumber);
      if (!promise) { promise = blockIdentity(this.client, snapshot.blockNumber); hashes.set(snapshot.blockNumber, promise); }
      return promise.then(block => block.blockHash === snapshot.blockHash);
    };
    const jobs = [...pools];
    await Promise.all(Array.from({ length: Math.min(this.policy.concurrentPools, jobs.length) }, async () => {
      while (jobs.length) {
        const pool = jobs.shift()!;
        try {
          let snapshot = this.store.snapshot(pool.address);
          if (snapshot) {
            try {
              validateSnapshot(snapshot, pool.tickSpacing);
              if (snapshot.blockNumber > blockNumber || !await canonical(snapshot)) snapshot = null;
            } catch { snapshot = null; }
          }
          if (!snapshot) {
            try { snapshot = await this.download(pool, identity, canonical, initialLive.get(pool.address.toLowerCase())); }
            catch (error) {
              // Resume when historical reads work; otherwise restart at the new
              // target so a pruned or pre-deployment draft cannot strand a pool.
              const draft = this.store.draft(pool.address);
              if (!draft || draft.blockNumber >= blockNumber) throw error;
              this.store.discardDraft(pool.address);
              snapshot = await this.download(pool, identity, canonical);
            }
          }
          loaded.push(snapshot);
        } catch {
          failed.push(pool.address);
        }
      }
    }));

    // Catch-up is chunked by block and address count. No pool is published at a partial block.
    const ready: V3Snapshot[] = [];
    for (let start = 0; start < loaded.length; start += this.policy.eventAddressBatchSize) {
      const group = loaded.slice(start, start + this.policy.eventAddressBatchSize);
      try {
        ready.push(...await this.catchUp(group, pools, identity));
      } catch {
        // A provider may have pruned history. Rebuild only the affected pools at the target block.
        for (const old of group) {
          const pool = pools.find(pool => pool.address.toLowerCase() === old.poolAddress.toLowerCase())!;
          try {
            this.store.discardDraft(pool.address);
            ready.push(await this.download(pool, identity, canonical));
          } catch { failed.push(pool.address); }
        }
      }
    }
    if ((await blockIdentity(this.client, blockNumber)).blockHash !== identity.blockHash) throw new Error('Chain changed during V3 snapshot load; retry');
    this.store.saveSnapshots(ready);
    return { snapshots: ready, failed };
  }

  private async download(pool: V3PoolConfig, identity: Identity, canonical: (identity: Identity) => Promise<boolean>, initialLive?: LiveResult): Promise<V3Snapshot> {
    const bounds = tickWordBounds(pool.tickSpacing);
    let draft = this.store.draft(pool.address);
    if (draft && (draft.blockNumber > identity.blockNumber || draft.minWord !== bounds.minWord || draft.maxWord !== bounds.maxWord || !await canonical(draft))) draft = null;
    if (!draft) {
      const live = initialLive ?? (await queryBatches<Address, LiveResult>(this.client, 'getV3LiveStates', [pool.address], 1, identity.blockNumber))[0];
      if (live.pool.toLowerCase() !== pool.address.toLowerCase()) throw new Error('Wrong pool in V3 live response');
      draft = { poolAddress: pool.address, sqrtPriceX96: BigInt(live.sqrtPriceX96), tick: Number(live.tick), liquidity: BigInt(live.liquidity), ...identity, ...bounds, nextWord: bounds.minWord, complete: false, bitmapWords: [], ticks: [] };
      this.store.saveDraft(draft);
    }
    if (!Number.isInteger(draft.nextWord) || draft.nextWord < bounds.minWord || draft.nextWord > bounds.maxWord + 1) throw new Error('Invalid V3 draft cursor');
    while (draft.nextWord <= bounds.maxWord) {
      const requests: { pool: Address; startWord: number; wordCount: number }[] = [];
      for (let word = draft.nextWord; word <= bounds.maxWord && requests.length < this.policy.batchSize;) {
        const wordCount = Math.min(this.policy.bitmapWordsPerPage, bounds.maxWord - word + 1);
        requests.push({ pool: pool.address, startWord: word, wordCount });
        word += wordCount;
      }
      const pages = await queryBatches<(typeof requests)[number], V3BitmapWord[]>(this.client, 'getV3TickBitmapWords', requests, this.policy.batchSize, draft.blockNumber);
      for (let i = 0; i < pages.length; i++) {
        const request = requests[i];
        const words = pages[i].map(word => ({ wordPosition: Number(word.wordPosition), bitmap: BigInt(word.bitmap) }));
        if (words.length !== request.wordCount || words.some((word, index) => word.wordPosition !== request.startWord + index)) throw new Error('Missing V3 bitmap page');
        const indexes = initializedTickIndexes(words, pool.tickSpacing);
        const ticks = await this.fetchTicks(pool.address, indexes, draft.blockNumber);
        if (ticks.some(tick => tick.liquidityGross === 0n)) throw new Error('Initialized bitmap tick is missing');
        draft.bitmapWords.push(...words.filter(word => word.bitmap !== 0n));
        draft.ticks.push(...ticks);
        draft.nextWord = request.startWord + request.wordCount;
        this.store.saveDraft(draft);
      }
    }
    if (!await canonical(draft)) throw new Error('V3 draft block is no longer canonical');
    const { nextWord: _nextWord, ...snapshot } = draft;
    snapshot.complete = true;
    validateSnapshot(snapshot, pool.tickSpacing);
    this.store.saveSnapshots([snapshot]);
    return snapshot;
  }

  private async fetchTicks(pool: Address, indexes: readonly number[], blockNumber: bigint): Promise<V3Tick[]> {
    const read = async (ticks: readonly number[]): Promise<V3Tick[]> => {
      try {
        const [records] = await queryBatches(this.client, 'getV3Ticks', [{ pool, ticks }], 1, blockNumber) as TickResult[][];
        if (records.length !== ticks.length || records.some((record, i) => Number(record.tick) !== ticks[i])) throw new Error('Missing V3 tick records');
        return records.map(record => {
          const liquidityGross = BigInt(record.liquidityGross);
          if (record.initialized !== (liquidityGross > 0n)) throw new Error('Invalid V3 tick initialization');
          return { index: Number(record.tick), liquidityGross, liquidityNet: BigInt(record.liquidityNet) };
        });
      } catch (error) {
        if (ticks.length <= 1) throw error;
        const middle = Math.floor(ticks.length / 2);
        return [...await read(ticks.slice(0, middle)), ...await read(ticks.slice(middle))];
      }
    };
    const result: V3Tick[] = [];
    for (let start = 0; start < indexes.length; start += this.policy.ticksPerBatch) result.push(...await read(indexes.slice(start, start + this.policy.ticksPerBatch)));
    return result;
  }

  private async catchUp(snapshots: V3Snapshot[], pools: readonly V3PoolConfig[], target: Identity): Promise<V3Snapshot[]> {
    let from = snapshots.reduce((min, snapshot) => snapshot.blockNumber < min ? snapshot.blockNumber : min, target.blockNumber) + 1n;
    while (from <= target.blockNumber) {
      const to = from + this.policy.catchUpBlockRange - 1n < target.blockNumber ? from + this.policy.catchUpBlockRange - 1n : target.blockNumber;
      const identity = to === target.blockNumber ? target : await blockIdentity(this.client, to);
      const pending = snapshots.filter(snapshot => snapshot.blockNumber < to);
      const logs = await readLogs(this.client, { address: pending.map(snapshot => snapshot.poolAddress), events: V3_POOL_EVENT_ABI }, from, to);
      const touched = new Map<string, Set<number>>();
      for (const log of logs) {
        if (log.removed || log.blockNumber === null) throw new Error('Noncanonical V3 event');
        const key = log.address.toLowerCase();
        const snapshot = pending.find(snapshot => snapshot.poolAddress.toLowerCase() === key);
        if (!snapshot || BigInt(log.blockNumber) <= snapshot.blockNumber) continue;
        const event = decodeV3PoolEvent(log);
        if (!event) throw new Error('Could not decode V3 catch-up event');
        if (event.kind === 'collect') continue;
        const ticks = touched.get(key) ?? new Set<number>();
        if (event.kind === 'liquidity') { ticks.add(event.update.tickLower); ticks.add(event.update.tickUpper); }
        touched.set(key, ticks);
      }
      const changed = pending.filter(snapshot => touched.has(snapshot.poolAddress.toLowerCase()));
      const live = await queryBatches<Address, LiveResult>(this.client, 'getV3LiveStates', changed.map(snapshot => snapshot.poolAddress), this.policy.batchSize, to);
      for (let i = 0; i < changed.length; i++) {
        const snapshot = changed[i];
        const pool = pools.find(pool => pool.address.toLowerCase() === snapshot.poolAddress.toLowerCase())!;
        if (live[i].pool.toLowerCase() !== snapshot.poolAddress.toLowerCase()) throw new Error('Wrong V3 live-state order');
        snapshot.sqrtPriceX96 = BigInt(live[i].sqrtPriceX96);
        snapshot.tick = Number(live[i].tick);
        snapshot.liquidity = BigInt(live[i].liquidity);
        const ticks = new Map(snapshot.ticks.map(tick => [tick.index, tick]));
        const words = new Map(snapshot.bitmapWords.map(word => [word.wordPosition, word.bitmap]));
        const indexes = [...touched.get(snapshot.poolAddress.toLowerCase())!];
        for (const tick of await this.fetchTicks(pool.address, indexes, to)) {
          const compressed = tick.index / pool.tickSpacing;
          if (!Number.isInteger(compressed)) throw new Error('V3 liquidity event tick is not aligned');
          const position = Math.floor(compressed / 256);
          const mask = 1n << BigInt(compressed - position * 256);
          const bitmap = words.get(position) ?? 0n;
          if (tick.liquidityGross > 0n) { ticks.set(tick.index, tick); words.set(position, bitmap | mask); }
          else { ticks.delete(tick.index); words.set(position, bitmap & ~mask); }
        }
        snapshot.ticks = [...ticks.values()];
        snapshot.bitmapWords = [...words].filter(([, bitmap]) => bitmap !== 0n).map(([wordPosition, bitmap]) => ({ wordPosition, bitmap }));
        validateSnapshot(snapshot, pool.tickSpacing);
      }
      if ((await blockIdentity(this.client, to)).blockHash !== identity.blockHash) throw new Error('Chain changed during V3 event replay');
      for (const snapshot of pending) Object.assign(snapshot, identity);
      this.store.saveSnapshots(pending);
      from = to + 1n;
    }
    return snapshots;
  }
}
