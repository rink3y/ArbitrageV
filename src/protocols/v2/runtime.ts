import { logger } from '../../reporting/logger';
import { type Address } from 'viem';
import { type PublicClient } from 'viem';
import { type MarketGraph } from '../../market-graph/market-graph';
import { type ProtocolEventAdapter } from '../../runtime/protocol-event-adapter';
import { decodeV2SyncEvent, V2_SYNC_EVENT_ABI } from './events';
import { type ReserveUpdate } from './types';

import { CONTRACTS, TOKENS } from '../../constants';
import { V2_DISCOVERY_POLICY as PAIR_DISCOVERY_POLICY, V2_FACTORIES as DEX_FACTORIES, V2_LIVE_POLICY } from './config';
import UniswapFlashQueryABI from '../../ABI/UniswapFlashQuery.json';
import { type PairInfo as MarketPairInfo } from './types';
import { type V2PoolMetadata } from './metadata';
import { compareChainLogs } from '../../runtime/chain-cursor';
import { profileV2Transfers } from './transfer-probes';

type V2Client = {
    readContract(parameters: any): Promise<unknown>;
};

type DiscoveredPairInfo = V2PoolMetadata & {
    reserve0: bigint;
    reserve1: bigint;
    lastTimestamp: number;
};

function isPairActive(lastTimestamp: number): boolean {
    const currentTime = Math.floor(Date.now() / 1000);
    const pairAge = currentTime - lastTimestamp;
    return pairAge <= PAIR_DISCOVERY_POLICY.maxPairAgeSeconds;
}

function hasEnoughLiquidity(pair: DiscoveredPairInfo): boolean {
    let hasMonitoredToken = false;
    
    for (const { address, liquidityAmount } of TOKENS) {
        if (pair.token0 === address) {
            hasMonitoredToken = true;
            if (logger.debugEnabled) logger.debug(`Checking liquidity for monitored token ${address} in pair ${pair.pairAddress} (token0)`);
            if (pair.reserve0 < liquidityAmount) {
                if (logger.debugEnabled) logger.debug(`Insufficient liquidity for monitored token ${address}: ${pair.reserve0} < ${liquidityAmount}`);
                return false;
            }
        }
        if (pair.token1 === address) {
            hasMonitoredToken = true;
            if (logger.debugEnabled) logger.debug(`Checking liquidity for monitored token ${address} in pair ${pair.pairAddress} (token1)`);
            if (pair.reserve1 < liquidityAmount) {
                if (logger.debugEnabled) logger.debug(`Insufficient liquidity for monitored token ${address}: ${pair.reserve1} < ${liquidityAmount}`);
                return false;
            }
        }
    }
    
    if (hasMonitoredToken) {
        return true;
    }
    
    const hasEnoughLiquidity = pair.reserve0 >= PAIR_DISCOVERY_POLICY.minOtherTokenLiquidity ||
                              pair.reserve1 >= PAIR_DISCOVERY_POLICY.minOtherTokenLiquidity;
                              
    if (logger.debugEnabled && !hasEnoughLiquidity) {
        logger.debug(`Insufficient liquidity for non-monitored pair ${pair.pairAddress}: ` +
                   `reserve0=${pair.reserve0}, reserve1=${pair.reserve1}, ` +
                   `required=${PAIR_DISCOVERY_POLICY.minOtherTokenLiquidity}`);
    }
    
    return hasEnoughLiquidity;
}

async function getReservesForPairs(
    client: V2Client,
    pairs: DiscoveredPairInfo[],
    blockNumber?: bigint
): Promise<DiscoveredPairInfo[]> {
    try {
        const reserves = await client.readContract({
            address: CONTRACTS.flashQuery as Address,
            abi: UniswapFlashQueryABI,
            functionName: 'getReservesByPairs',
            args: [pairs.map(p => p.pairAddress)],
            ...(blockNumber === undefined ? {} : { blockNumber }),
        }) as bigint[][];

        return pairs.map((pair, i) => ({
            ...pair,
            reserve0: reserves[i][0],
            reserve1: reserves[i][1],
            lastTimestamp: Number(reserves[i][2])
        }));
    } catch (error) {
        if (logger.debugEnabled) {
            logger.error('Error fetching reserves:', error);
        }
        throw error;
    }
}

async function getReservesWithRetry(
    client: V2Client,
    pairs: DiscoveredPairInfo[]
): Promise<DiscoveredPairInfo[]> {
    const result: DiscoveredPairInfo[] = [];
    
    // Group pairs by factory
    const pairsByFactory: { [factory: string]: DiscoveredPairInfo[] } = {};
    
    for (const pair of pairs) {
        if (!pairsByFactory[pair.factory]) {
            pairsByFactory[pair.factory] = [];
        }
        pairsByFactory[pair.factory].push(pair);
    }
    
    // Process each factory's pairs with appropriate batch size
    for (const factory of Object.keys(pairsByFactory)) {
        const factoryPairs = pairsByFactory[factory];
        const factoryConfig = DEX_FACTORIES.find(f => f.name === factory);
        const isSolidlyFactory = factoryConfig?.kind === 'solidly';
        const batchSize = isSolidlyFactory
            ? PAIR_DISCOVERY_POLICY.solidlyReserveBatchSize
            : PAIR_DISCOVERY_POLICY.batchSize;
        
        if (logger.debugEnabled) {
            logger.debug(`Processing ${factoryPairs.length} pairs from ${factory} with batch size ${batchSize}`);
        }
        
        for (let i = 0; i < factoryPairs.length; i += batchSize) {
            const batch = factoryPairs.slice(i, i + batchSize);
            try {
                if (logger.debugEnabled) {
                    logger.debug(`Fetching reserves for ${batch.length} pairs from ${factory} (${i + 1} to ${i + batch.length})`);
                }

                const pairsWithReserves = await getReservesForPairs(client, batch);
                
                const validPairs = pairsWithReserves.filter(pair => 
                    isPairActive(pair.lastTimestamp) && 
                    hasEnoughLiquidity(pair)
                );
                
                const skippedCount = batch.length - validPairs.length;
                if (skippedCount > 0 && logger.debugEnabled) {
                    logger.debug(`Skipped ${skippedCount} pairs (${
                        batch.length - validPairs.length - pairsWithReserves.filter(p => !isPairActive(p.lastTimestamp)).length
                    } with zero reserves, ${
                        pairsWithReserves.filter(p => !isPairActive(p.lastTimestamp)).length
                    } inactive, ${
                        pairsWithReserves.filter(p => !hasEnoughLiquidity(p)).length
                    } insufficient liquidity)`);
                }
                
                result.push(...validPairs);
            } catch (error) {
                logger.error(`Failed to fetch reserves for batch ${i} to ${i + batch.length}${logger.debugEnabled ? `, skipping these pairs: ${
                    batch.map(p => p.pairAddress).join(', ')
                }` : ''}`);
                continue;
            }
        }
    }
    
    return result;
}

export async function getKnownPairsInfo(
    client: V2Client,
    pools: readonly V2PoolMetadata[]
): Promise<MarketPairInfo[]> {
    const discovered = pools.map(pool => ({
        ...pool,
        reserve0: 0n,
        reserve1: 0n,
        lastTimestamp: 0,
    }));
    const pairsWithReserves = await getReservesWithRetry(client, discovered);
    logger.info(`Successfully fetched reserves for ${pairsWithReserves.length} pairs`);
    return pairsWithReserves;
}

export async function refreshKnownPairsInfo(
    client: V2Client,
    pools: readonly V2PoolMetadata[],
    blockNumber?: bigint
): Promise<MarketPairInfo[]> {
    if (pools.length === 0) return [];
    const discovered = pools.map(pool => ({
        ...pool,
        reserve0: 0n,
        reserve1: 0n,
        lastTimestamp: 0,
    }));
    const refreshed: MarketPairInfo[] = [];
    const byFactory = Map.groupBy(discovered, pair => pair.factory);
    for (const [factory, pairs] of byFactory) {
        const batchSize = DEX_FACTORIES.find(config => config.name === factory)?.kind === 'solidly'
            ? PAIR_DISCOVERY_POLICY.solidlyReserveBatchSize
            : PAIR_DISCOVERY_POLICY.batchSize;
        for (let start = 0; start < pairs.length; start += batchSize) {
            refreshed.push(...await getReservesForPairs(client, pairs.slice(start, start + batchSize), blockNumber));
        }
    }
    return refreshed;
}

export class V2EventAdapter implements ProtocolEventAdapter {
  private transferTimer: ReturnType<typeof setTimeout> | undefined;
  private transferStopped = true;
  private transferGeneration = 0;
  readonly id = 'v2';
  private readonly pools = new Map<string, V2PoolMetadata>();
  private readonly pendingLogs = new Map<string, { logs: any[] | null }>();
  private readonly subscribed = new Set<string>();
  private readonly unwatch = new Set<() => void | Promise<void>>();
  private watchClient: PublicClient | undefined;
  private onLogs: ((logs: any[]) => void | Promise<void>) | undefined;
  private onError: ((error: any) => void | Promise<void>) | undefined;

  constructor(
    private readonly client: PublicClient<any, any, any>,
    private readonly graph: MarketGraph,
    pools: readonly V2PoolMetadata[],
    private readonly scan: (changedPairs: readonly string[], releasedPairs?: readonly Address[]) => Promise<void>
  ) {
    for (const pool of pools) this.pools.set(pool.pairAddress.toLowerCase(), pool);
  }

  addresses(): readonly Address[] {
    return [...this.pools.values()].map(pool => pool.pairAddress);
  }

  owns(address: Address): boolean {
    return this.pools.has(address.toLowerCase());
  }

  async watch(client: PublicClient, onLogs: (logs: any[]) => void | Promise<void>, onError: (error: any) => void | Promise<void>) {
    this.watchClient = client;
    this.onLogs = onLogs;
    this.onError = onError;
    try {
      await this.subscribe(this.addresses());
      this.transferStopped = false;
      this.scheduleTransferRefresh();
      return [() => this.stopWatching()];
    } catch (error) {
      await this.stopWatching();
      throw error;
    }
  }

  async replacePools(pools: readonly V2PoolMetadata[]): Promise<void> {
    const next = new Map(pools.map(pool => [pool.pairAddress.toLowerCase(), pool]));
    const removed: Address[] = [];
    for (const [key, pool] of this.pools) {
      if (next.has(key)) continue;
      this.pools.delete(key);
      this.pendingLogs.delete(key);
      this.graph.removePair(pool.pairAddress);
      removed.push(pool.pairAddress);
    }

    const added: V2PoolMetadata[] = [];
    for (const [key, pool] of next) {
      const previous = this.pools.get(key);
      this.pools.set(key, pool);
      if (previous && samePool(previous, pool)) continue;
      if (previous) {
        this.graph.removePair(previous.pairAddress);
        removed.push(previous.pairAddress);
      }
      this.pendingLogs.set(key, { logs: [] });
      added.push(pool);
    }
    if (removed.length > 0) await this.scan(removed, removed);
    await this.subscribe(added.map(pool => pool.pairAddress));

    const hydrate = [...this.pendingLogs.keys()]
      .map(key => next.get(key))
      .filter((pool): pool is V2PoolMetadata => pool !== undefined);
    if (hydrate.length > 0) {
      for (const pool of hydrate) this.pendingLogs.get(pool.pairAddress.toLowerCase())!.logs = [];
      const floor = await this.client.getBlockNumber({ cacheTime: 0 });
      const pairs = await refreshKnownPairsInfo(this.client, hydrate, floor);
      const replay: any[] = [];
      for (const pair of pairs) {
        const key = pair.pairAddress.toLowerCase();
        if (!this.pools.has(key)) continue;
        const pending = this.pendingLogs.get(key);
        if (!pending?.logs) continue;
        this.graph.addPair(pair);
        this.pendingLogs.delete(key);
        replay.push(...pending.logs
          .filter(log => typeof log.blockNumber === 'bigint' && log.blockNumber > floor)
          .sort(compareChainLogs));
      }
      for (const update of this.decodeUpdates(replay)) {
        const pool = this.pools.get(update.pairAddress.toLowerCase());
        if (pool) this.graph.addPair({ ...pool, reserve0: update.reserve0, reserve1: update.reserve1 });
      }
    }
    const changed = added.map(pool => pool.pairAddress);
    if (changed.length > 0) await this.scan(changed, changed);
  }

  bufferKey(log: any): string | null {
    const key = log.address?.toLowerCase();
    return key && this.pools.has(key) ? key : null;
  }

  async reconcile(logs: readonly any[]): Promise<void> {
    const addresses: Address[] = [];
    for (const log of logs) {
      if (log.address) addresses.push(log.address);
    }
    await this.reconcileAddresses(addresses);
  }

  async reconcileAddresses(addresses: readonly Address[]): Promise<void> {
    const touched = new Map<string, V2PoolMetadata>();
    for (const address of addresses) {
      const key = address.toLowerCase();
      const pool = this.pools.get(key);
      if (pool) touched.set(key, pool);
    }
    const pairs = await refreshKnownPairsInfo(this.client, [...touched.values()]);
    for (const pair of pairs) this.graph.addPair(pair);
    if (pairs.length > 0) await this.scan(pairs.map(pair => pair.pairAddress), pairs.map(pair => pair.pairAddress));
  }

  async apply(logs: any[]): Promise<void> {
    const ready: any[] = [];
    for (const log of logs) {
      const key = log.address?.toLowerCase();
      if (key && this.pendingLogs.has(key)) {
        const pending = this.pendingLogs.get(key)!;
        if (pending.logs && pending.logs.length < V2_LIVE_POLICY.recoveryLogsPerPool) pending.logs.push(log);
        else pending.logs = null;
        continue;
      }
      ready.push(log);
    }
    const updates = this.decodeUpdates(ready);
    // Apply absolute reserves before yielding to search. Coalescing belongs to
    // search requests, otherwise an in-flight worker can appear falsely fresh.
    if (updates.length > 0) await this.applyUpdates(updates);
  }

  private decodeUpdates(logs: readonly any[]): ReserveUpdate[] {
    const updates: ReserveUpdate[] = [];
    for (const log of logs) {
      const pool = log.address ? this.pools.get(log.address.toLowerCase()) : undefined;
      const decoded = pool ? decodeV2SyncEvent(log) : null;
      if (pool && decoded) updates.push({ pairAddress: pool.pairAddress, ...decoded });
    }
    return updates;
  }

  private async applyUpdates(updates: ReserveUpdate[]): Promise<void> {
    for (const update of updates) {
      const pool = this.pools.get(update.pairAddress.toLowerCase());
      if (!pool) continue;
      this.graph.addPair({ ...pool, reserve0: update.reserve0, reserve1: update.reserve1 });
    }
    await this.scan(updates.map(update => update.pairAddress), updates.map(update => update.pairAddress));
  }

  private async subscribe(addresses: readonly Address[]): Promise<void> {
    if (!this.watchClient || !this.onLogs || !this.onError) return;
    const fresh = addresses.filter(address => !this.subscribed.has(address.toLowerCase()));
    for (let start = 0; start < fresh.length; start += 500) {
      const batch = fresh.slice(start, start + 500);
      const stop = await this.watchClient.watchContractEvent({
        address: batch,
        abi: V2_SYNC_EVENT_ABI,
        strict: true,
        onLogs: this.onLogs,
        onError: this.onError,
      });
      this.unwatch.add(stop);
      for (const address of batch) this.subscribed.add(address.toLowerCase());
    }
  }

  private async stopWatching(): Promise<void> {
    this.transferStopped = true;
    this.transferGeneration++;
    clearTimeout(this.transferTimer);
    for (const stop of this.unwatch) await stop();
    this.unwatch.clear();
    this.subscribed.clear();
    this.watchClient = undefined;
    this.onLogs = undefined;
    this.onError = undefined;
  }

  private scheduleTransferRefresh(): void {
    if (!V2_LIVE_POLICY.transferFees || this.transferStopped) return;
    const generation = this.transferGeneration;
    this.transferTimer = setTimeout(async () => {
      try {
        const pairs = this.graph.getAllPairs();
        if (pairs.every(pair => pair.transferProfiles && Math.min(pair.transferProfiles.token0.validUntil, pair.transferProfiles.token1.validUntil) > Date.now())) return;
        const profiled = await profileV2Transfers(this.client, pairs);
        if (this.transferStopped || generation !== this.transferGeneration) return;
        const current = new Map(this.graph.getAllPairs().map(pair => [pair.pairAddress.toLowerCase(), pair]));
        const changed: Address[] = [];
        for (const pair of profiled) {
          const live = current.get(pair.pairAddress.toLowerCase());
          if (!live || !pair.transferProfiles ||
              (live.transferProfiles && live.transferProfiles.token0.observedAt >= pair.transferProfiles.token0.observedAt &&
               live.transferProfiles.token1.observedAt >= pair.transferProfiles.token1.observedAt)) continue;
          // Only update profiles. Events may have changed reserves while probes were running.
          this.graph.addPair({ ...live, transferProfiles: pair.transferProfiles });
          changed.push(pair.pairAddress);
        }
        if (changed.length) await this.scan(changed, changed);
      } catch (error) { logger.error('V2 transfer refresh failed; expired profiles remain ineligible:', error); }
      finally { if (generation === this.transferGeneration) this.scheduleTransferRefresh(); }
    }, Math.min(60_000, V2_LIVE_POLICY.transferRefreshMs));
  }
}

function samePool(a: V2PoolMetadata, b: V2PoolMetadata): boolean {
  return a.pairAddress.toLowerCase() === b.pairAddress.toLowerCase() &&
    a.token0.toLowerCase() === b.token0.toLowerCase() && a.token1.toLowerCase() === b.token1.toLowerCase() &&
    a.factory === b.factory && a.fee === b.fee && a.variant === b.variant && a.scale0 === b.scale0 && a.scale1 === b.scale1;
}
