import { type V3FactoryConfig } from './types';

// Standard Uniswap V3 PoolCreated interface. Addresses are documented in README.md.
// fromBlock is inclusive. Set the verified deployment block to shorten the first scan.
export const V3_FACTORIES: readonly V3FactoryConfig[] = [
  { name: 'dragon', address: '0x179D9a5592Bc77050796F7be28058c51cA575df4', fromBlock: 0n, enabled: true },
  { name: 'oku', address: '0x75FC67473A91335B5b8F8821277262a13B38c9b3', fromBlock: 0n, enabled: true },
  { name: 'sailor', address: '0xA51136931fdd3875902618bF6B3abe38Ab2D703b', fromBlock: 0n, enabled: true },
];

export const V3_DISCOVERY_POLICY = {
  blockRange: 100_000n,
  confirmations: 12n,
  batchSize: 32,
} as const;

export const V3_STARTUP_POLICY = {
  batchSize: 5,
  bitmapWordsPerPage: 32,
  ticksPerBatch: 128,
  concurrentPools: 4,
  eventAddressBatchSize: 100,
  catchUpBlockRange: 10_000n,
} as const;
