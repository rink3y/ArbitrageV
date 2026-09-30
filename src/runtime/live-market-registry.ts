import { filterDiscoveredMarkets } from '../market-filter';
import { updateMarketPools, type MarketSnapshot } from '../market-db';
import { type V2PoolMetadata } from '../protocols/v2/metadata';
import { type V3PoolConfig } from '../protocols/v3/types';

type LiveMarketSource<T> = {
  load(): readonly T[];
  publish(markets: readonly T[]): Promise<void>;
};

export class LiveMarketRegistry {
  private v2: LiveMarketSource<V2PoolMetadata> | undefined;
  private v3: LiveMarketSource<V3PoolConfig> | undefined;
  private work: Promise<void> | undefined;
  private rerun = false;

  constructor(
    private readonly catalog: MarketSnapshot,
    private readonly save: (snapshot: MarketSnapshot) => void = updateMarketPools
  ) {}

  registerV2(load: () => readonly V2PoolMetadata[], publish: (markets: readonly V2PoolMetadata[]) => Promise<void>): void {
    this.v2 = { load, publish };
  }

  registerV3(load: () => readonly V3PoolConfig[], publish: (markets: readonly V3PoolConfig[]) => Promise<void>): void {
    this.v3 = { load, publish };
  }

  reconcile(): Promise<void> {
    this.rerun = true;
    if (this.work) return this.work;
    this.work = Promise.resolve().then(async () => {
      while (this.rerun) {
        this.rerun = false;
        await this.reconcileOnce();
      }
    }).finally(() => { this.work = undefined; });
    return this.work;
  }

  private async reconcileOnce(): Promise<void> {
    const v2 = this.v2;
    const v3 = this.v3;
    const filtered = filterDiscoveredMarkets(
      v2?.load() ?? this.catalog.v2Pools,
      v3?.load() ?? this.catalog.v3Pools,
      this.catalog.carbonPairs
    );
    const next: MarketSnapshot = {
      v2Pools: v2 ? filtered.v2Pools : this.catalog.v2Pools,
      v3Pools: v3 ? filtered.v3Pools : this.catalog.v3Pools,
      carbonPairs: this.catalog.carbonPairs,
    };
    if (catalogKey(next) !== catalogKey(this.catalog)) this.save(next);
    this.catalog.v2Pools = next.v2Pools;
    this.catalog.v3Pools = next.v3Pools;
    await Promise.all([
      v2?.publish(next.v2Pools),
      v3?.publish(next.v3Pools),
    ]);
  }
}

function catalogKey(catalog: MarketSnapshot): string {
  return [
    ...catalog.v2Pools.map(pool => `v2:${pool.pairAddress.toLowerCase()}:${pool.token0.toLowerCase()}:${pool.token1.toLowerCase()}:${pool.factory}:${pool.fee}:${pool.variant}:${pool.scale0}:${pool.scale1}`),
    ...catalog.v3Pools.map(pool => `v3:${pool.address.toLowerCase()}:${pool.token0.toLowerCase()}:${pool.token1.toLowerCase()}:${pool.fee}:${pool.tickSpacing}`),
  ].sort().join('|');
}
