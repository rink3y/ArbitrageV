import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceMarketSnapshot } from '../src/market-db';
import { V2Store, type V2DiscoveryCheckpoint } from '../src/protocols/v2/store';
import { address, hash } from './helpers/v3-fixture';

test('V2 discovery and its checkpoint survive catalog replacement and restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'arb-v2-store-'));
  const path = join(directory, 'markets.sqlite');
  const factory = address(900);
  const metadata = {
    pairAddress: address(1), token0: address(100), token1: address(101), factory: 'test',
    fee: 30, variant: 'uniswap-v2' as const, scale0: 1n, scale1: 1n,
  };
  const checkpoint: V2DiscoveryCheckpoint = {
    pairCount: 1, blockNumber: 10n, blockHash: hash(10n), configuration: 'test',
  };
  try {
    const first = new V2Store(path);
    first.saveDiscovery(factory, [metadata], checkpoint);
    first.close();

    replaceMarketSnapshot({ v2Pools: [metadata], v3Pools: [], carbonPairs: [] }, path);
    replaceMarketSnapshot({ v2Pools: [], v3Pools: [], carbonPairs: [] }, path);

    const reopened = new V2Store(path);
    expect(reopened.pools([factory])).toEqual([metadata]);
    expect(reopened.checkpoint(factory)).toEqual(checkpoint);
    reopened.close();
  } finally {
    Bun.gc(true);
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
