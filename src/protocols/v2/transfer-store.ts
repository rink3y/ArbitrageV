import { type Address } from 'viem';
import { openMarketDb } from '../../market-db';
import { type TokenTransferProfile } from './transfer-fees';

export class TransferProfileStore {
  private readonly db;
  constructor(path?: string) {
    this.db = openMarketDb(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS v2_transfer_profiles (
      executor TEXT NOT NULL, origin TEXT NOT NULL, pool TEXT NOT NULL, token TEXT NOT NULL,
      profile TEXT NOT NULL, PRIMARY KEY(executor, origin, pool, token))`);
  }
  get(executor: Address, origin: Address, pool: Address, token: Address): TokenTransferProfile | undefined {
    const row = this.db.query('SELECT profile FROM v2_transfer_profiles WHERE executor=? AND origin=? AND pool=? AND token=?')
      .get(...[executor, origin, pool, token].map(s => s.toLowerCase())) as { profile: string } | null;
    return row ? JSON.parse(row.profile, (_, v) => v && typeof v === 'object' && Object.keys(v).length === 1 && typeof v.$bigint === 'string' ? BigInt(v.$bigint) : v) : undefined;
  }
  save(profile: TokenTransferProfile): void {
    this.db.query(`INSERT INTO v2_transfer_profiles VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(executor, origin, pool, token) DO UPDATE SET profile=excluded.profile
      WHERE json_extract(excluded.profile, '$.observedAt') >= json_extract(v2_transfer_profiles.profile, '$.observedAt')`).run(
      ...[profile.executor, profile.origin, profile.pool, profile.token].map(s => s.toLowerCase()),
      JSON.stringify(profile, (_, v) => typeof v === 'bigint' ? { $bigint: v.toString() } : v));
  }
  close(): void { this.db.close(); }
}
