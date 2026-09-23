import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Address } from 'viem';
import { NETWORK } from '../../constants';
import { marketDbPath } from '../../market-db';
import { type V3PoolMetadata, type V3Snapshot } from './types';

export type DiscoveryCheckpoint = { fromBlock: bigint; blockNumber: bigint; blockHash: `0x${string}` };
export type V3Draft = V3Snapshot & { nextWord: number };

const encode = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { bigint: item.toString() } : item);
const decode = <T>(value: string): T => JSON.parse(value, (_key, item) => item && typeof item === 'object' && Object.keys(item).length === 1 && typeof item.bigint === 'string' ? BigInt(item.bigint) : item);

// Additive tables keep discovery and snapshots independent of the replaceable trading catalog.
export class V3Store {
  private readonly db: Database;

  constructor(path = marketDbPath(), private readonly chainId: number = NETWORK.chain.id) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS v3_discovered_pools (
        chain_id INTEGER NOT NULL, address TEXT NOT NULL, factory TEXT NOT NULL, metadata TEXT NOT NULL,
        PRIMARY KEY(chain_id, address)
      );
      CREATE TABLE IF NOT EXISTS v3_discovery_checkpoints (
        chain_id INTEGER NOT NULL, factory TEXT NOT NULL, checkpoint TEXT NOT NULL,
        PRIMARY KEY(chain_id, factory)
      );
      CREATE TABLE IF NOT EXISTS v3_snapshots (
        chain_id INTEGER NOT NULL, address TEXT NOT NULL, snapshot TEXT NOT NULL,
        PRIMARY KEY(chain_id, address)
      );
      CREATE TABLE IF NOT EXISTS v3_snapshot_drafts (
        chain_id INTEGER NOT NULL, address TEXT NOT NULL, draft TEXT NOT NULL,
        PRIMARY KEY(chain_id, address)
      );
    `);
  }

  close(): void { this.db.close(); }

  pools(factories: readonly Address[]): V3PoolMetadata[] {
    const enabled = new Set(factories.map(address => address.toLowerCase()));
    const rows = this.db.query('SELECT factory, metadata FROM v3_discovered_pools WHERE chain_id = ? ORDER BY address').all(this.chainId) as { factory: string; metadata: string }[];
    return rows.filter(row => enabled.has(row.factory)).map(row => decode<V3PoolMetadata>(row.metadata));
  }

  checkpoint(factory: Address): DiscoveryCheckpoint | null {
    return this.read<DiscoveryCheckpoint>('v3_discovery_checkpoints', 'factory', 'checkpoint', factory);
  }

  saveDiscovery(factory: Address, pools: readonly V3PoolMetadata[], checkpoint: DiscoveryCheckpoint): void {
    this.db.transaction(() => {
      const insert = this.db.query('INSERT OR REPLACE INTO v3_discovered_pools VALUES (?, ?, ?, ?)');
      for (const pool of pools) insert.run(this.chainId, pool.address.toLowerCase(), factory.toLowerCase(), encode(pool));
      this.db.query('INSERT OR REPLACE INTO v3_discovery_checkpoints VALUES (?, ?, ?)').run(this.chainId, factory.toLowerCase(), encode(checkpoint));
    })();
  }

  resetFactory(factory: Address): void {
    this.db.transaction(() => {
      const pools = this.pools([factory]);
      for (const pool of pools) this.discardSnapshot(pool.address);
      this.db.query('DELETE FROM v3_discovered_pools WHERE chain_id = ? AND factory = ?').run(this.chainId, factory.toLowerCase());
      this.db.query('DELETE FROM v3_discovery_checkpoints WHERE chain_id = ? AND factory = ?').run(this.chainId, factory.toLowerCase());
    })();
  }

  snapshot(address: Address): V3Snapshot | null { return this.read('v3_snapshots', 'address', 'snapshot', address); }
  draft(address: Address): V3Draft | null { return this.read('v3_snapshot_drafts', 'address', 'draft', address); }

  saveDraft(draft: V3Draft): void {
    this.db.query('INSERT OR REPLACE INTO v3_snapshot_drafts VALUES (?, ?, ?)').run(this.chainId, draft.poolAddress.toLowerCase(), encode(draft));
  }

  saveSnapshots(snapshots: readonly V3Snapshot[]): void {
    this.db.transaction(() => {
      for (const snapshot of snapshots) {
        if (!snapshot.complete) throw new Error('Cannot publish an incomplete V3 snapshot');
        this.db.query('INSERT OR REPLACE INTO v3_snapshots VALUES (?, ?, ?)').run(this.chainId, snapshot.poolAddress.toLowerCase(), encode(snapshot));
        this.db.query('DELETE FROM v3_snapshot_drafts WHERE chain_id = ? AND address = ?').run(this.chainId, snapshot.poolAddress.toLowerCase());
      }
    })();
  }

  discardSnapshot(address: Address): void {
    this.db.query('DELETE FROM v3_snapshots WHERE chain_id = ? AND address = ?').run(this.chainId, address.toLowerCase());
    this.discardDraft(address);
  }

  discardDraft(address: Address): void {
    this.db.query('DELETE FROM v3_snapshot_drafts WHERE chain_id = ? AND address = ?').run(this.chainId, address.toLowerCase());
  }

  private read<T>(table: string, key: string, column: string, address: Address): T | null {
    const row = this.db.query(`SELECT ${column} AS value FROM ${table} WHERE chain_id = ? AND ${key} = ?`).get(this.chainId, address.toLowerCase()) as { value: string } | null;
    return row ? decode<T>(row.value) : null;
  }
}
