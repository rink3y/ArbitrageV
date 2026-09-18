import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMarketSnapshot, replaceMarketSnapshot } from '../src/market-db';

const token0 = '0x0000000000000000000000000000000000000001' as const;
const token1 = '0x0000000000000000000000000000000000000002' as const;

describe('market catalog', () => {
  test('replaces and loads one domain snapshot', () => {
    const directory = mkdtempSync(join(tmpdir(), 'arb-market-'));
    const path = join(directory, 'markets.sqlite');

    try {
      replaceMarketSnapshot({
        v2Pools: [{
          pairAddress: '0x0000000000000000000000000000000000000010',
          token0,
          token1,
          fee: 30,
          factory: 'test-v2',
          variant: 'solidly-stable',
          scale0: 1_000_000n,
          scale1: 1_000_000n,
        }],
        v3Pools: [{
          name: 'test-v3',
          address: '0x0000000000000000000000000000000000000020',
          token0,
          token1,
          fee: 500,
          tickSpacing: 10,
          enabled: true,
        }],
        carbonPairs: [{
          controller: '0x0000000000000000000000000000000000000030',
          token0,
          token1,
          strategyCount: 2,
          feePpm: 4_000,
        }],
      }, path);

      const snapshot = loadMarketSnapshot(path);
      expect(snapshot.v2Pools).toHaveLength(1);
      expect(snapshot.v3Pools).toHaveLength(1);
      expect(snapshot.carbonPairs).toHaveLength(1);
      expect(snapshot.v2Pools[0].factory).toBe('test-v2');
      expect(snapshot.v2Pools[0].variant).toBe('solidly-stable');
      expect(snapshot.v2Pools[0].scale0).toBe(1_000_000n);
      expect(snapshot.v2Pools[0].scale1).toBe(1_000_000n);
      expect(snapshot.v3Pools[0].tickSpacing).toBe(10);
      expect(snapshot.carbonPairs[0].strategyCount).toBe(2);
      expect(snapshot.carbonPairs[0].feePpm).toBe(4_000);
    } finally {
      Bun.gc(true);
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
