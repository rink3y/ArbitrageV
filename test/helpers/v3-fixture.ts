import { encodeAbiParameters, encodeEventTopics, type Address } from 'viem';
import { V3_POOL_EVENT_ABI, V3_SAILOR_SWAP_EVENT } from '../../src/protocols/v3/events';
import { type V3PoolConfig, type V3Tick } from '../../src/protocols/v3/types';
import { type SnapshotPolicy } from '../../src/protocols/v3/snapshots';

export const address = (id: number): Address => `0x${id.toString(16).padStart(40, '0')}`;
export const hash = (id: bigint): `0x${string}` => `0x${id.toString(16).padStart(64, '0')}`;
export const factory = address(900);
export const policy: SnapshotPolicy = { batchSize: 2, bitmapWordsPerPage: 1, ticksPerBatch: 2, concurrentPools: 2, eventAddressBatchSize: 10, catchUpBlockRange: 10n };

export function pool(id = 1, tickSpacing = 32767): V3PoolConfig {
  return { name: `pool-${id}`, address: address(id), token0: address(100), token1: address(101), fee: 3000, tickSpacing, enabled: true };
}

export function v3Fixture(pools = [pool()]) {
  const fixture = {
    head: 10n,
    calls: [] as any[],
    logs: [] as any[],
    hashes: new Map<bigint, `0x${string}`>(),
    callbacks: [] as Array<(logs: any[]) => Promise<void>>,
    failure: (_parameters: any) => false,
    ticks: new Map<string, V3Tick[]>(pools.map(pool => [pool.address, [
      { index: -pool.tickSpacing, liquidityGross: 1000n, liquidityNet: 1000n },
      { index: pool.tickSpacing, liquidityGross: 1000n, liquidityNet: -1000n },
    ]])),
    liquidity: 1000n,
    price: 2n ** 96n,
    client: {} as any,
  };
  fixture.client = {
    getBlockNumber: async () => fixture.head,
    getBlock: async ({ blockNumber }: any) => ({ number: blockNumber, hash: fixture.hashes.get(blockNumber) ?? hash(blockNumber) }),
    getLogs: async (parameters: any) => {
      fixture.calls.push({ functionName: 'getLogs', ...parameters });
      if (fixture.failure({ functionName: 'getLogs', ...parameters })) throw new Error('fixture log failure');
      const addresses = Array.isArray(parameters.address) ? parameters.address : [parameters.address];
      return fixture.logs.filter(log => addresses.map((address: string) => address.toLowerCase()).includes(log.address.toLowerCase()) && log.blockNumber >= parameters.fromBlock && log.blockNumber <= parameters.toBlock);
    },
    watchContractEvent: (parameters: any) => {
      fixture.callbacks.push(parameters.onLogs);
      return () => {};
    },
    readContract: async (parameters: any) => {
      fixture.calls.push(parameters);
      if (fixture.failure(parameters)) throw new Error('fixture read failure');
      switch (parameters.functionName) {
        case 'getV3PoolMetadata': return parameters.args[0].map((address: Address) => {
          const selected = pools.find(pool => pool.address === address)!;
          return { ...selected, pool: address, factory };
        });
        case 'getV3LiveStates': return parameters.args[0].map((pool: Address) => ({ pool, sqrtPriceX96: fixture.price, liquidity: fixture.liquidity, tick: 0 }));
        case 'getV3TickBitmapWords': return parameters.args[0].map((request: any) => {
          const spacing = pools.find(pool => pool.address === request.pool)!.tickSpacing;
          return Array.from({ length: request.wordCount }, (_, i) => {
            const wordPosition = request.startWord + i;
            let bitmap = 0n;
            for (const tick of fixture.ticks.get(request.pool) ?? []) {
              const compressed = tick.index / spacing;
              if (Math.floor(compressed / 256) === wordPosition) bitmap |= 1n << BigInt(compressed - wordPosition * 256);
            }
            return { wordPosition, bitmap };
          });
        });
        case 'getV3Ticks': return parameters.args[0].map((request: any) => request.ticks.map((index: number) => {
          const tick = fixture.ticks.get(request.pool)?.find(tick => tick.index === index);
          return { tick: index, liquidityGross: tick?.liquidityGross ?? 0n, liquidityNet: tick?.liquidityNet ?? 0n, initialized: Boolean(tick && tick.liquidityGross > 0n) };
        }));
        default: throw new Error(`Unexpected query ${parameters.functionName}`);
      }
    },
  };
  return fixture;
}

export function liquidityLog(pool: V3PoolConfig, kind: 'Mint' | 'Burn', blockNumber: bigint, lower = -pool.tickSpacing, upper = pool.tickSpacing) {
  return {
    address: pool.address, blockNumber, transactionIndex: 0, logIndex: 0,
    topics: encodeEventTopics({ abi: V3_POOL_EVENT_ABI, eventName: kind, args: { owner: address(99), tickLower: lower, tickUpper: upper } }),
    data: kind === 'Mint'
      ? encodeAbiParameters([{ type: 'address' }, { type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }], [address(99), 1000n, 0n, 0n])
      : encodeAbiParameters([{ type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }], [1000n, 0n, 0n]),
  };
}

export function swapLog(pool: V3PoolConfig, blockNumber: bigint, sailor = false) {
  return {
    address: pool.address, blockNumber, transactionIndex: 0, logIndex: 1,
    topics: encodeEventTopics({ abi: sailor ? [V3_SAILOR_SWAP_EVENT] : V3_POOL_EVENT_ABI, eventName: 'Swap', args: { sender: address(99), recipient: address(99) } }),
    data: sailor
      ? encodeAbiParameters([{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint128' }, { type: 'uint128' }], [1n, -1n, 2n ** 96n, 1000n, 0, 0n, 0n])
      : encodeAbiParameters([{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }], [1n, -1n, 2n ** 96n, 1000n, 0]),
  };
}
