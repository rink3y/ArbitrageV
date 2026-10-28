import { logger } from '../../reporting/logger';
import { parseAbi, type Address } from 'viem';
import UniswapFlashQueryABI from '../../ABI/UniswapFlashQuery.json';
import bannedTokens from '../../bannedtax.json';
import { CONTRACTS } from '../../constants';
import { type DexFactoryConfig, V2_DISCOVERY_POLICY, V2_FACTORIES } from './config';
import { V2Store, type V2DiscoveryCheckpoint } from './store';
import { type V2Variant } from './types';

const BASE_V1_PAIR_ABI = parseAbi([
  'function metadata() view returns (uint256 scale0, uint256 scale1, uint256 reserve0, uint256 reserve1, bool stable, address token0, address token1)',
]);
const BASE_V1_FACTORY_ABI = parseAbi([
  'function getFee(bool stable) view returns (uint256)',
]);

export type V2PoolMetadata = {
  pairAddress: Address;
  token0: Address;
  token1: Address;
  fee: number;
  factory: string;
  variant: V2Variant;
  scale0: bigint;
  scale1: bigint;
};

export type V2Client = {
  readContract(parameters: any): Promise<unknown>;
  getBlockNumber(parameters?: { cacheTime: number }): Promise<bigint>;
  getBlock(parameters: { blockNumber: bigint }): Promise<{ number: bigint | null; hash: `0x${string}` | null }>;
};
type BaseV1Metadata = {
  scale0: bigint;
  scale1: bigint;
  reserve0: bigint;
  reserve1: bigint;
  stable: boolean;
  token0: Address;
  token1: Address;
};
type RawBaseV1Metadata = BaseV1Metadata | readonly [bigint, bigint, bigint, bigint, boolean, Address, Address];
type SolidlyFees = { stable: number; volatile: number };
const bannedTokenSet = new Set(bannedTokens.map(token => token.toLowerCase()));

export async function discoverV2PoolMetadata(
  client: V2Client,
  store: V2Store,
  factories: readonly DexFactoryConfig[] = V2_FACTORIES
): Promise<V2PoolMetadata[]> {
  await refreshV2PoolMetadata(client, store, factories);
  const pools = store.pools(factories.map(factory => factory.address));
  logger.info(`Found ${pools.length} V2 pools across ${factories.length} factories`);
  return pools;
}

// Update checkpoints without materializing the saved catalog on every live check.
export async function refreshV2PoolMetadata(
  client: V2Client,
  store: V2Store,
  factories: readonly DexFactoryConfig[] = V2_FACTORIES
): Promise<{ poolsSaved: number; factoriesReset: number }> {
  let poolsSaved = 0;
  let factoriesReset = 0;
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const identity = await blockIdentity(client, head);
  const lengths = await getPairsLength(client, factories, head);
  for (const factory of factories) {
    const total = lengths.get(factory.address.toLowerCase()) ?? 0;
    const fees = factory.kind === 'solidly' && total > 0 ? await getSolidlyFees(client, factory.address, head) : null;
    const configuration = JSON.stringify({ name: factory.name, fee: factory.fee, kind: factory.kind, fees });
    let checkpoint = store.checkpoint(factory.address);
    if (checkpoint && (checkpoint.configuration !== configuration || checkpoint.pairCount > total ||
      checkpoint.blockNumber > head || (await blockIdentity(client, checkpoint.blockNumber)).blockHash !== checkpoint.blockHash)) {
      store.resetFactory(factory.address);
      factoriesReset++;
      checkpoint = null;
    }
    const batchSize = factory.kind === 'solidly'
      ? V2_DISCOVERY_POLICY.solidlyReserveBatchSize
      : V2_DISCOVERY_POLICY.batchSize;
    let start = checkpoint?.pairCount ?? 0;
    let saved = false;
    while (start < total) {
      const stop = Math.min(start + batchSize, total);
      const pools = await getPairsInRange(client, factory, start, stop, fees, head);
      store.saveDiscovery(factory.address, pools, { pairCount: stop, ...identity, configuration });
      poolsSaved += pools.length;
      saved = true;
      start = stop;
    }
    if (!checkpoint && !saved) store.saveDiscovery(factory.address, [], { pairCount: total, ...identity, configuration });
  }
  if ((await blockIdentity(client, head)).blockHash !== identity.blockHash) throw new Error('Chain changed during V2 discovery; retry');
  return { poolsSaved, factoriesReset };
}

async function getPairsLength(client: V2Client, factories: readonly DexFactoryConfig[], blockNumber: bigint): Promise<Map<string, number>> {
  const lengths = await client.readContract({
    address: CONTRACTS.flashQuery as Address,
    abi: UniswapFlashQueryABI,
    functionName: 'getPairsLength',
    args: [factories.map(factory => factory.address)],
    blockNumber,
  }) as bigint[];
  if (lengths.length !== factories.length) throw new Error('Incomplete V2 pair counts');
  return new Map(factories.map((factory, index) => {
    const count = Number(lengths[index]);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid V2 pair count for ${factory.name}`);
    return [factory.address.toLowerCase(), count];
  }));
}

async function getPairsInRange(
  client: V2Client,
  factory: DexFactoryConfig,
  start: number,
  stop: number,
  fees: SolidlyFees | null,
  blockNumber: bigint
): Promise<V2PoolMetadata[]> {
  try {
    const pairs = await client.readContract({
      address: CONTRACTS.flashQuery as Address,
      abi: UniswapFlashQueryABI,
      functionName: 'getPairsByIndexRange',
      args: [factory.address, BigInt(start), BigInt(stop)],
      blockNumber,
    }) as Address[][];
    const discovered = pairs
      .filter(([token0, token1]) => !bannedTokenSet.has(token0.toLowerCase()) && !bannedTokenSet.has(token1.toLowerCase()))
      .map(([token0, token1, pairAddress]) => ({
        pairAddress,
        token0,
        token1,
        factory: factory.name,
        fee: factory.fee,
        variant: 'uniswap-v2' as const,
        scale0: 1n,
        scale1: 1n,
      }));
    if (factory.kind !== 'solidly' || discovered.length === 0) return discovered;

    const stable = await client.readContract({
      address: CONTRACTS.flashQuery as Address,
      abi: UniswapFlashQueryABI,
      functionName: 'filterVolatileHermesPairs',
      args: [discovered.map(pair => pair.pairAddress)],
      blockNumber,
    }) as boolean[];
    if (stable.length !== discovered.length) throw new Error(`Incomplete ${factory.name} stable-pair response`);

    return Promise.all(discovered.map(async (pair, index) => {
      const isStable = stable[index];
      const metadata = isStable
        ? normalizeBaseV1Metadata(await client.readContract({
            address: pair.pairAddress,
            abi: BASE_V1_PAIR_ABI,
            functionName: 'metadata',
            blockNumber,
          }) as RawBaseV1Metadata)
        : null;
      return {
        ...pair,
        fee: isStable ? fees!.stable : fees!.volatile,
        variant: isStable ? 'solidly-stable' : 'solidly-volatile',
        scale0: metadata?.scale0 ?? 1n,
        scale1: metadata?.scale1 ?? 1n,
      };
    }));
  } catch (error) {
    if (!String(error).toLowerCase().includes('revert')) throw error;
    if (stop - start > 1) {
      const middle = start + Math.floor((stop - start) / 2);
      if (logger.debugEnabled) logger.warn(`Retrying ${factory.name} V2 range ${start}-${stop} as smaller calls`);
      return [
        ...await getPairsInRange(client, factory, start, middle, fees, blockNumber),
        ...await getPairsInRange(client, factory, middle, stop, fees, blockNumber),
      ];
    }
    throw new Error(`Cannot read ${factory.name} V2 pair index ${start}`, { cause: error });
  }
}

async function getSolidlyFees(client: V2Client, factory: Address, blockNumber: bigint): Promise<SolidlyFees> {
  const [stable, volatile] = await Promise.all([true, false].map(stable => client.readContract({
    address: factory,
    abi: BASE_V1_FACTORY_ABI,
    functionName: 'getFee',
    args: [stable],
    blockNumber,
  }) as Promise<bigint>));
  return { stable: Number(stable), volatile: Number(volatile) };
}

async function blockIdentity(client: V2Client, blockNumber: bigint): Promise<Pick<V2DiscoveryCheckpoint, 'blockNumber' | 'blockHash'>> {
  const block = await client.getBlock({ blockNumber });
  if (block.number !== blockNumber || !block.hash) throw new Error(`Missing V2 block ${blockNumber}`);
  return { blockNumber, blockHash: block.hash };
}

function normalizeBaseV1Metadata(metadata: RawBaseV1Metadata): BaseV1Metadata {
  if (!Array.isArray(metadata)) return metadata as BaseV1Metadata;
  return {
    scale0: metadata[0],
    scale1: metadata[1],
    reserve0: metadata[2],
    reserve1: metadata[3],
    stable: metadata[4],
    token0: metadata[5],
    token1: metadata[6],
  };
}
