import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Address } from 'viem';
import { NETWORK } from '../../constants';
import { marketDbPath } from '../../market-db';
import { type V2PoolMetadata } from './metadata';

export type V2DiscoveryCheckpoint = {
  pairCount: number;
  blockNumber: bigint;
  blockHash: `0x${string}`;
  configuration: string;
};

const encode = (value: unknown) => JSON.stringify(value, (_key, item) =>
  typeof item === 'bigint' ? { bigint: item.toString() } : item);
const decode = <T>(value: string): T => JSON.parse(value, (_key, item) =>
  item && typeof item === 'object' && Object.keys(item).length === 1 && typeof item.bigint === 'string'
    ? BigInt(item.bigint)
    : item);

export class V2Store {
  private readonly db: Database;

  constructor(path = marketDbPath(), private readonly chainId = NETWORK.chain.id) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS v2_discovered_pools (
        chain_id INTEGER NOT NULL, address TEXT NOT NULL, factory TEXT NOT NULL, metadata TEXT NOT NULL,
        PRIMARY KEY(chain_id, address)
      );
      CREATE TABLE IF NOT EXISTS v2_discovery_checkpoints (
        chain_id INTEGER NOT NULL, factory TEXT NOT NULL, checkpoint TEXT NOT NULL,
        PRIMARY KEY(chain_id, factory)
      );
    `);
  }

  close(): void { this.db.close(); }

  pools(factories: readonly Address[]): V2PoolMetadata[] {
    const enabled = new Set(factories.map(address => address.toLowerCase()));
    const rows = this.db.query(
      'SELECT factory, metadata FROM v2_discovered_pools WHERE chain_id = ? ORDER BY address'
    ).all(this.chainId) as Array<{ factory: string; metadata: string }>;
    return rows.filter(row => enabled.has(row.factory)).map(row => decode<V2PoolMetadata>(row.metadata));
  }

  checkpoint(factory: Address): V2DiscoveryCheckpoint | null {
    const row = this.db.query(
      'SELECT checkpoint FROM v2_discovery_checkpoints WHERE chain_id = ? AND factory = ?'
    ).get(this.chainId, factory.toLowerCase()) as { checkpoint: string } | null;
    return row ? decode<V2DiscoveryCheckpoint>(row.checkpoint) : null;
  }

  saveDiscovery(factory: Address, pools: readonly V2PoolMetadata[], checkpoint: V2DiscoveryCheckpoint): void {
    this.db.transaction(() => {
      const insert = this.db.query('INSERT OR REPLACE INTO v2_discovered_pools VALUES (?, ?, ?, ?)');
      for (const pool of pools) {
        insert.run(this.chainId, pool.pairAddress.toLowerCase(), factory.toLowerCase(), encode(pool));
      }
      this.db.query('INSERT OR REPLACE INTO v2_discovery_checkpoints VALUES (?, ?, ?)')
        .run(this.chainId, factory.toLowerCase(), encode(checkpoint));
    })();
  }

  resetFactory(factory: Address): void {
    this.db.transaction(() => {
      this.db.query('DELETE FROM v2_discovered_pools WHERE chain_id = ? AND factory = ?')
        .run(this.chainId, factory.toLowerCase());
      this.db.query('DELETE FROM v2_discovery_checkpoints WHERE chain_id = ? AND factory = ?')
        .run(this.chainId, factory.toLowerCase());
    })();
  }
}
