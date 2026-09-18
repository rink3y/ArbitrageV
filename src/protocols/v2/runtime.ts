import { type Address } from 'viem';
import { type PublicClient } from 'viem';
import { type MarketGraph } from '../../market-graph/market-graph';
import { LatestUpdateScheduler } from '../../runtime/event-scheduler';
import { type ProtocolEventAdapter } from '../../runtime/protocol-event-adapter';
import { decodeV2SyncEvent, V2_SYNC_EVENT_ABI } from './events';
import { type ReserveUpdate } from './types';

import { CONTRACTS, RUNTIME, TOKENS } from '../../constants';
import { V2_DISCOVERY_POLICY as PAIR_DISCOVERY_POLICY, V2_FACTORIES as DEX_FACTORIES } from './config';
import UniswapFlashQueryABI from '../../ABI/UniswapFlashQuery.json';
import { type PairInfo as MarketPairInfo } from './types';
import { type V2PoolMetadata } from './metadata';

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
            if (RUNTIME.debug) console.log(`Checking liquidity for monitored token ${address} in pair ${pair.pairAddress} (token0)`);
            if (pair.reserve0 < liquidityAmount) {
                if (RUNTIME.debug) console.log(`Insufficient liquidity for monitored token ${address}: ${pair.reserve0} < ${liquidityAmount}`);
                return false;
            }
        }
        if (pair.token1 === address) {
            hasMonitoredToken = true;
            if (RUNTIME.debug) console.log(`Checking liquidity for monitored token ${address} in pair ${pair.pairAddress} (token1)`);
            if (pair.reserve1 < liquidityAmount) {
                if (RUNTIME.debug) console.log(`Insufficient liquidity for monitored token ${address}: ${pair.reserve1} < ${liquidityAmount}`);
                return false;
            }
        }
    }
    
    if (hasMonitoredToken) {
        return true;
    }
    
    const hasEnoughLiquidity = pair.reserve0 >= PAIR_DISCOVERY_POLICY.minOtherTokenLiquidity ||
                              pair.reserve1 >= PAIR_DISCOVERY_POLICY.minOtherTokenLiquidity;
                              
    if (RUNTIME.debug && !hasEnoughLiquidity) {
        console.log(`Insufficient liquidity for non-monitored pair ${pair.pairAddress}: ` +
                   `reserve0=${pair.reserve0}, reserve1=${pair.reserve1}, ` +
                   `required=${PAIR_DISCOVERY_POLICY.minOtherTokenLiquidity}`);
    }
    
    return hasEnoughLiquidity;
}

async function getReservesForPairs(
    client: V2Client,
    pairs: DiscoveredPairInfo[]
): Promise<DiscoveredPairInfo[]> {
    try {
        const reserves = await client.readContract({
            address: CONTRACTS.flashQuery as Address,
            abi: UniswapFlashQueryABI,
            functionName: 'getReservesByPairs',
            args: [pairs.map(p => p.pairAddress)],
        }) as bigint[][];

        return pairs.map((pair, i) => ({
            ...pair,
            reserve0: reserves[i][0],
            reserve1: reserves[i][1],
            lastTimestamp: Number(reserves[i][2])
        }));
    } catch (error) {
        if (RUNTIME.debug) {
            console.error('Error fetching reserves:', error);
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
        
        if (RUNTIME.debug) {
            console.log(`Processing ${factoryPairs.length} pairs from ${factory} with batch size ${batchSize}`);
        }
        
        for (let i = 0; i < factoryPairs.length; i += batchSize) {
            const batch = factoryPairs.slice(i, i + batchSize);
            try {
                if (RUNTIME.debug) {
                    console.log(`Fetching reserves for ${batch.length} pairs from ${factory} (${i + 1} to ${i + batch.length})`);
                }

                const pairsWithReserves = await getReservesForPairs(client, batch);
                
                const validPairs = pairsWithReserves.filter(pair => 
                    isPairActive(pair.lastTimestamp) && 
                    hasEnoughLiquidity(pair)
                );
                
                const skippedCount = batch.length - validPairs.length;
                if (skippedCount > 0 && RUNTIME.debug) {
                    console.log(`Skipped ${skippedCount} pairs (${
                        batch.length - validPairs.length - pairsWithReserves.filter(p => !isPairActive(p.lastTimestamp)).length
                    } with zero reserves, ${
                        pairsWithReserves.filter(p => !isPairActive(p.lastTimestamp)).length
                    } inactive, ${
                        pairsWithReserves.filter(p => !hasEnoughLiquidity(p)).length
                    } insufficient liquidity)`);
                }
                
                result.push(...validPairs);
            } catch (error) {
                console.error(`Failed to fetch reserves for batch ${i} to ${i + batch.length}${RUNTIME.debug ? `, skipping these pairs: ${
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
    console.log(`Successfully fetched reserves for ${pairsWithReserves.length} pairs`);
    return pairsWithReserves;
}

export async function refreshKnownPairsInfo(
    client: V2Client,
    pools: readonly V2PoolMetadata[]
): Promise<MarketPairInfo[]> {
    if (pools.length === 0) return [];
    const discovered = pools.map(pool => ({
        ...pool,
        reserve0: 0n,
        reserve1: 0n,
        lastTimestamp: 0,
    }));
    const refreshed: MarketPairInfo[] = [];
    for (let start = 0; start < discovered.length; start += PAIR_DISCOVERY_POLICY.batchSize) {
        refreshed.push(...await getReservesForPairs(
            client,
            discovered.slice(start, start + PAIR_DISCOVERY_POLICY.batchSize)
        ));
    }
    return refreshed;
}

export class V2EventAdapter implements ProtocolEventAdapter {
  readonly id = 'v2';
  private readonly pools = new Map<string, V2PoolMetadata>();
  private readonly scheduler: LatestUpdateScheduler<ReserveUpdate>;

  constructor(
    private readonly client: PublicClient<any, any, any>,
    private readonly graph: MarketGraph,
    pools: readonly V2PoolMetadata[],
    private readonly scan: (changedPairs: readonly string[], releasedPairs?: readonly Address[]) => Promise<void>
  ) {
    for (const pool of pools) this.pools.set(pool.pairAddress.toLowerCase(), pool);
    this.scheduler = new LatestUpdateScheduler(
      updates => this.applyUpdates(updates),
      update => update.pairAddress.toLowerCase()
    );
  }

  addresses(): readonly Address[] {
    return [...this.pools.values()].map(pool => pool.pairAddress);
  }

  owns(address: Address): boolean {
    return this.pools.has(address.toLowerCase());
  }

  async watch(client: PublicClient, onLogs: (logs: any[]) => void | Promise<void>, onError: (error: any) => void | Promise<void>) {
    if (this.pools.size === 0) return [];
    const unwatch = await client.watchContractEvent({
      address: [...this.pools.values()].map(pool => pool.pairAddress),
      abi: V2_SYNC_EVENT_ABI,
      strict: true,
      onLogs,
      onError,
    });
    return [unwatch];
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
  }

  async apply(logs: any[]): Promise<void> {
    let count = 0;
    const updates = new Array<ReserveUpdate>(logs.length);
    for (const log of logs) {
      const key = log.address?.toLowerCase();
      const pool = key ? this.pools.get(key) : undefined;
      const decoded = pool ? decodeV2SyncEvent(log) : null;
      if (pool && decoded) updates[count++] = { pairAddress: pool.pairAddress, ...decoded };
    }
    updates.length = count;
    if (count > 0) await this.scheduler.submit(updates);
  }

  clear(): void {
    this.scheduler.clear();
  }

  private async applyUpdates(updates: ReserveUpdate[]): Promise<void> {
    for (const update of updates) {
      const pool = this.pools.get(update.pairAddress.toLowerCase());
      if (!pool) continue;
      this.graph.addPair({ ...pool, reserve0: update.reserve0, reserve1: update.reserve1 });
    }
    await this.scan(updates.map(update => update.pairAddress), updates.map(update => update.pairAddress));
  }
}
