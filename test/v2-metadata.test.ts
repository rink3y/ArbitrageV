import { expect, test } from 'bun:test';
import { type Address } from 'viem';
import { discoverV2PoolMetadata } from '../src/protocols/v2/metadata';
import { V2Store } from '../src/protocols/v2/store';
import { type DexFactoryConfig } from '../src/protocols/v2/config';

const address = (value: number) => `0x${value.toString(16).padStart(40, '0')}` as Address;
const blockHash = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}` as `0x${string}`;

test('V2 discovery splits a reverted range without using the Solidly filter for Dragon', async () => {
  const ranges: Array<[number, number]> = [];
  let filterCalls = 0;
  const client = {
    async getBlockNumber() { return 10n; },
    async getBlock({ blockNumber }: any) { return { number: blockNumber, hash: blockHash(blockNumber) }; },
    async readContract({ functionName, args }: any): Promise<unknown> {
      if (functionName === 'getPairsLength') return [4n, 0n];
      if (functionName === 'filterVolatileHermesPairs') {
        filterCalls++;
        return [];
      }
      if (functionName === 'getPairsByIndexRange') {
        const start = Number(args[1]);
        const stop = Number(args[2]);
        ranges.push([start, stop]);
        if (stop - start > 2) throw new Error('execution reverted');
        return Array.from({ length: stop - start }, (_, index) => [
          address(100 + start + index),
          address(200 + start + index),
          address(300 + start + index),
        ]);
      }
      throw new Error(`Unexpected ${functionName}`);
    },
  };

  const store = new V2Store(':memory:');
  const pools = await discoverV2PoolMetadata(client, store);
  store.close();
  expect(pools).toHaveLength(4);
  expect(ranges).toEqual([[0, 4], [0, 2], [2, 4]]);
  expect(filterCalls).toBe(0);
});

test('Solidly discovery reads factory fees once and persists stable metadata', async () => {
  const feeCalls: boolean[] = [];
  const client = {
    async getBlockNumber() { return 10n; },
    async getBlock({ blockNumber }: any) { return { number: blockNumber, hash: blockHash(blockNumber) }; },
    async readContract({ functionName, args }: any): Promise<unknown> {
      if (functionName === 'getPairsLength') return [0n, 2n];
      if (functionName === 'getPairsByIndexRange') return [
        [address(1), address(2), address(11)],
        [address(3), address(4), address(12)],
      ];
      if (functionName === 'filterVolatileHermesPairs') return [true, false];
      if (functionName === 'getFee') {
        if (args.length !== 1) throw new Error('wrong getFee ABI');
        feeCalls.push(args[0]);
        return args[0] ? 4n : 18n;
      }
      if (functionName === 'metadata') return {
        scale0: 1_000_000n,
        scale1: 1_000_000n,
        reserve0: 1n,
        reserve1: 1n,
        stable: true,
        token0: address(1),
        token1: address(2),
      };
      throw new Error(`Unexpected ${functionName}`);
    },
  };

  const store = new V2Store(':memory:');
  const pools = await discoverV2PoolMetadata(client, store);
  store.close();
  expect(feeCalls).toEqual([true, false]);
  expect(pools.map(pool => [pool.variant, pool.fee, pool.scale0])).toEqual([
    ['solidly-stable', 4, 1_000_000n],
    ['solidly-volatile', 18, 1n],
  ]);
});

test('V2 discovery resumes from the saved pair count and resets after a reorg', async () => {
  const factory: DexFactoryConfig = { name: 'test', address: address(900), fee: 30, kind: 'uniswap-v2' };
  const ranges: Array<[number, number, bigint]> = [];
  const hashes = new Map<bigint, `0x${string}`>();
  let head = 10n;
  let count = 2;
  const client = {
    async getBlockNumber() { return head; },
    async getBlock({ blockNumber }: { blockNumber: bigint }) {
      return { number: blockNumber, hash: hashes.get(blockNumber) ?? blockHash(blockNumber) };
    },
    async readContract({ functionName, args, blockNumber }: any): Promise<unknown> {
      if (functionName === 'getPairsLength') return [BigInt(count)];
      if (functionName === 'getPairsByIndexRange') {
        const start = Number(args[1]);
        const stop = Number(args[2]);
        ranges.push([start, stop, blockNumber]);
        return Array.from({ length: stop - start }, (_, index) => [
          address(100 + start + index), address(200 + start + index), address(300 + start + index),
        ]);
      }
      throw new Error(`Unexpected ${functionName}`);
    },
  };
  const store = new V2Store(':memory:');
  try {
    expect(await discoverV2PoolMetadata(client, store, [factory])).toHaveLength(2);
    head = 11n;
    count = 3;
    expect(await discoverV2PoolMetadata(client, store, [factory])).toHaveLength(3);
    expect(ranges).toEqual([[0, 2, 10n], [2, 3, 11n]]);

    hashes.set(11n, blockHash(999n));
    head = 12n;
    await discoverV2PoolMetadata(client, store, [factory]);
    expect(ranges.at(-1)).toEqual([0, 3, 12n]);
  } finally { store.close(); }
});

test('V2 discovery never advances a checkpoint past an unreadable pair', async () => {
  const factory: DexFactoryConfig = { name: 'test', address: address(900), fee: 30, kind: 'uniswap-v2' };
  const client = {
    async getBlockNumber() { return 10n; },
    async getBlock({ blockNumber }: { blockNumber: bigint }) { return { number: blockNumber, hash: blockHash(blockNumber) }; },
    async readContract({ functionName }: any): Promise<unknown> {
      if (functionName === 'getPairsLength') return [1n];
      if (functionName === 'getPairsByIndexRange') throw new Error('execution reverted');
      throw new Error(`Unexpected ${functionName}`);
    },
  };
  const store = new V2Store(':memory:');
  try {
    await expect(discoverV2PoolMetadata(client, store, [factory])).rejects.toThrow('pair index 0');
    expect(store.checkpoint(factory.address)).toBeNull();
    expect(store.pools([factory.address])).toEqual([]);
  } finally { store.close(); }
});
