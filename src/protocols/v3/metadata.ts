import { parseAbiItem, type Address } from 'viem';
import { V3_DISCOVERY_POLICY, V3_FACTORIES } from './config';
import { tickWordBounds } from './coverage';
import { blockIdentity, queryBatches, readLogs, type V3Client } from './query';
import { V3Store } from './store';
import { type V3FactoryConfig, type V3PoolMetadata } from './types';

export const V3_POOL_CREATED = parseAbiItem('event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)');

type MetadataResult = { pool: Address; factory: Address; token0: Address; token1: Address; fee: number; tickSpacing: number };

export async function discoverV3Pools(
  client: V3Client, store: V3Store, factories: readonly V3FactoryConfig[] = V3_FACTORIES,
  policy: { blockRange: bigint; batchSize: number } = V3_DISCOVERY_POLICY
): Promise<V3PoolMetadata[]> {
  if (policy.blockRange <= 0n) throw new Error('Invalid V3 discovery policy');
  const enabled = factories.filter(factory => factory.enabled);
  if (enabled.length === 0) return [];
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const metadataBlock = await blockIdentity(client, head);
  for (const factory of enabled) {
    if (factory.fromBlock < 0n) throw new Error('V3 fromBlock must be non-negative');
    let checkpoint = store.checkpoint(factory.address);
    if (checkpoint && (checkpoint.fromBlock !== factory.fromBlock || checkpoint.blockNumber > head ||
      (await blockIdentity(client, checkpoint.blockNumber)).blockHash !== checkpoint.blockHash)) {
      store.resetFactory(factory.address);
      checkpoint = null;
    }
    for (let from = checkpoint ? checkpoint.blockNumber + 1n : factory.fromBlock; from <= head;) {
      const to = from + policy.blockRange - 1n < head ? from + policy.blockRange - 1n : head;
      const identity = await blockIdentity(client, to);
      const logs = await readLogs(client, { address: factory.address, event: V3_POOL_CREATED }, from, to);
      const events = new Map<string, any>();
      for (const log of logs) {
        if (log.removed || !log.args?.pool || log.blockNumber === null) throw new Error('Invalid V3 discovery log');
        events.set(log.args.pool.toLowerCase(), log);
      }
      // The query contract may have been deployed long after these pools. Their
      // immutable fields can be read at today's head, not the historical log block.
      const metadata = await queryBatches<Address, MetadataResult>(client, 'getV3PoolMetadata', [...events.values()].map(log => log.args.pool), policy.batchSize, head);
      const pools = metadata.map(result => {
        const event = events.get(result.pool.toLowerCase());
        if (!event || result.factory.toLowerCase() !== factory.address.toLowerCase() ||
          result.token0.toLowerCase() !== event.args.token0.toLowerCase() || result.token1.toLowerCase() !== event.args.token1.toLowerCase() ||
          Number(result.fee) !== Number(event.args.fee) || Number(result.tickSpacing) !== Number(event.args.tickSpacing)) {
          throw new Error('V3 pool metadata does not match its factory event');
        }
        return {
          name: `${factory.name}:${result.pool}`, address: result.pool, factory: factory.address,
          token0: result.token0, token1: result.token1, fee: Number(result.fee), tickSpacing: Number(result.tickSpacing),
          enabled: true, creationBlock: BigInt(event.blockNumber), ...tickWordBounds(Number(result.tickSpacing)),
        };
      });
      if ((await blockIdentity(client, to)).blockHash !== identity.blockHash) throw new Error('Chain changed during V3 discovery; retry sync');
      if (pools.length && (await blockIdentity(client, head)).blockHash !== metadataBlock.blockHash) throw new Error('Chain changed during V3 metadata reads; retry sync');
      store.saveDiscovery(factory.address, pools, { fromBlock: factory.fromBlock, ...identity });
      from = to + 1n;
    }
  }
  return store.pools(enabled.map(factory => factory.address));
}
