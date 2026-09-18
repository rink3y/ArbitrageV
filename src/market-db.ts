import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Address } from 'viem';
import { type V2PoolMetadata } from './protocols/v2/metadata';
import { type V2Variant } from './protocols/v2/types';
import { type CarbonPairMetadata } from './protocols/carbon/types';
import { type V3PoolConfig } from './protocols/v3/types';

type StoredPoolProtocol = 'v2' | 'v3';

type StoredPool = {
  address: Address;
  protocol: StoredPoolProtocol;
  factory: string | null;
  token0: Address;
  token1: Address;
  fee: number;
  tickSpacing: number | null;
  variant: V2Variant | null;
  scale0: string | null;
  scale1: string | null;
};

export type MarketSnapshot = {
  v2Pools: V2PoolMetadata[];
  v3Pools: V3PoolConfig[];
  carbonPairs: CarbonPairMetadata[];
};

type CarbonPairRow = {
  controller: string;
  token0: string;
  token1: string;
  strategy_count: number;
  fee_ppm: number;
};

export function loadMarketSnapshot(path = marketDbPath()): MarketSnapshot {
  const db = openMarketDb(path);
  try {
    const pools = loadStoredPools(db);
    return {
      v2Pools: storedV2Pools(pools),
      v3Pools: storedV3Pools(pools),
      carbonPairs: loadStoredCarbonPairs(db),
    };
  } finally {
    db.close();
  }
}

export function replaceMarketSnapshot(snapshot: MarketSnapshot, path = marketDbPath()): void {
  const db = openMarketDb(path);
  try {
    replaceStoredPools(db, [
      ...snapshot.v2Pools.map(toStoredV2Pool),
      ...snapshot.v3Pools.map(toStoredV3Pool),
    ]);
    replaceStoredCarbonPairs(db, snapshot.carbonPairs);
  } finally {
    db.close();
  }
}

function marketDbPath(): string {
  return process.env.MARKET_DB_PATH || 'data/markets.sqlite';
}

function openMarketDb(path = marketDbPath()): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  initMarketDb(db);
  return db;
}

function initMarketDb(db: Database): void {
  const version = db.query('PRAGMA user_version').get() as { user_version: number };
  if (version.user_version < 2) {
    db.exec('DROP TABLE IF EXISTS pools; DROP TABLE IF EXISTS carbon_pairs; PRAGMA user_version = 2');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS pools (
      address TEXT PRIMARY KEY,
      protocol TEXT NOT NULL,
      factory TEXT,
      token0 TEXT NOT NULL,
      token1 TEXT NOT NULL,
      fee INTEGER NOT NULL,
      tick_spacing INTEGER,
      variant TEXT,
      scale0 TEXT,
      scale1 TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS carbon_pairs (
      controller TEXT NOT NULL,
      token0 TEXT NOT NULL,
      token1 TEXT NOT NULL,
      strategy_count INTEGER NOT NULL,
      fee_ppm INTEGER NOT NULL DEFAULT 4000,
      PRIMARY KEY (controller, token0, token1)
    )
  `);
}

function replaceStoredPools(db: Database, pools: readonly StoredPool[]): void {
  const insert = db.query(`
    INSERT INTO pools (address, protocol, factory, token0, token1, fee, tick_spacing, variant, scale0, scale1)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const replace = db.transaction((rows: readonly StoredPool[]) => {
    db.exec('DELETE FROM pools');
    for (const pool of rows) {
      insert.run(
        pool.address,
        pool.protocol,
        pool.factory,
        pool.token0,
        pool.token1,
        pool.fee,
        pool.tickSpacing,
        pool.variant,
        pool.scale0,
        pool.scale1
      );
    }
  });

  replace(pools);
}

function loadStoredPools(db: Database): StoredPool[] {
  return db.query(`
    SELECT address, protocol, factory, token0, token1, fee,
      tick_spacing AS tickSpacing, variant, scale0, scale1
    FROM pools
  `).all() as StoredPool[];
}

function replaceStoredCarbonPairs(db: Database, pairs: readonly CarbonPairMetadata[]): void {
  const insert = db.query(`
    INSERT INTO carbon_pairs (controller, token0, token1, strategy_count, fee_ppm)
    VALUES (?, ?, ?, ?, ?)
  `);
  const replace = db.transaction((rows: readonly CarbonPairMetadata[]) => {
    db.exec('DELETE FROM carbon_pairs');
    for (const pair of rows) {
      insert.run(
        pair.controller,
        pair.token0,
        pair.token1,
        pair.strategyCount,
        pair.feePpm
      );
    }
  });

  replace(pairs);
}

function loadStoredCarbonPairs(db: Database): CarbonPairMetadata[] {
  const rows = db.query(`
    SELECT controller, token0, token1, strategy_count, fee_ppm
    FROM carbon_pairs
  `).all() as CarbonPairRow[];

  return rows.map(row => ({
    controller: row.controller as Address,
    token0: row.token0 as Address,
    token1: row.token1 as Address,
    strategyCount: row.strategy_count,
    feePpm: row.fee_ppm,
  }));
}

function toStoredV2Pool(pool: V2PoolMetadata): StoredPool {
  return {
    address: pool.pairAddress,
    protocol: 'v2',
    factory: pool.factory,
    token0: pool.token0,
    token1: pool.token1,
    fee: pool.fee,
    tickSpacing: null,
    variant: pool.variant,
    scale0: pool.scale0.toString(),
    scale1: pool.scale1.toString(),
  };
}

function toStoredV3Pool(pool: V3PoolConfig): StoredPool {
  return {
    address: pool.address,
    protocol: 'v3',
    factory: null,
    token0: pool.token0,
    token1: pool.token1,
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    variant: null,
    scale0: null,
    scale1: null,
  };
}

function storedV2Pools(pools: readonly StoredPool[]): V2PoolMetadata[] {
  return pools
    .filter(pool => pool.protocol === 'v2')
    .map(pool => ({
      pairAddress: pool.address,
      token0: pool.token0,
      token1: pool.token1,
      fee: pool.fee,
      factory: pool.factory || '',
      variant: pool.variant!,
      scale0: BigInt(pool.scale0!),
      scale1: BigInt(pool.scale1!),
    }));
}

function storedV3Pools(pools: readonly StoredPool[]): V3PoolConfig[] {
  return pools
    .filter(pool => pool.protocol === 'v3' && pool.tickSpacing !== null)
    .map(pool => ({
      name: pool.address,
      address: pool.address,
      token0: pool.token0,
      token1: pool.token1,
      fee: pool.fee,
      tickSpacing: pool.tickSpacing!,
      enabled: true,
    }));
}
