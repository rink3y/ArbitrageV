import { type Address } from 'viem';
import UniswapFlashQueryABI from '../../ABI/UniswapFlashQuery.json';
import { CONTRACTS } from '../../constants';

export type V3Client = {
  readContract(parameters: any): Promise<any>;
  getBlockNumber(parameters?: { cacheTime: number }): Promise<bigint>;
  getBlock(parameters: any): Promise<{ number: bigint | null; hash: `0x${string}` | null }>;
  getLogs(parameters: any): Promise<any[]>;
};

// Failed multi-item reads are retried in smaller batches; a single failure remains an error.
export async function queryBatches<TInput, TResult>(
  client: V3Client, functionName: string, inputs: readonly TInput[], batchSize: number, blockNumber: bigint
): Promise<TResult[]> {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('V3 batch size must be a positive integer');
  if (inputs.length > 0 && !CONTRACTS.flashQuery) throw new Error('UNISWAP_FLASH_QUERY_CONTRACT_ADDRESS is required');
  const read = async (batch: readonly TInput[]): Promise<TResult[]> => {
    try {
      const results = await client.readContract({
        address: CONTRACTS.flashQuery as Address, abi: UniswapFlashQueryABI, functionName, args: [batch], blockNumber,
      });
      if (!Array.isArray(results) || results.length !== batch.length) throw new Error(`Incomplete ${functionName} response`);
      return results;
    } catch (error) {
      if (batch.length === 1) throw error;
      const middle = Math.floor(batch.length / 2);
      return [...await read(batch.slice(0, middle)), ...await read(batch.slice(middle))];
    }
  };
  const results: TResult[] = [];
  for (let start = 0; start < inputs.length; start += batchSize) results.push(...await read(inputs.slice(start, start + batchSize)));
  return results;
}

export async function blockIdentity(client: V3Client, blockNumber: bigint) {
  const block = await client.getBlock({ blockNumber });
  if (block.number !== blockNumber || !block.hash) throw new Error(`Missing V3 block ${blockNumber}`);
  return { blockNumber, blockHash: block.hash };
}

export async function readLogs(client: V3Client, parameters: Record<string, unknown>, fromBlock: bigint, toBlock: bigint): Promise<any[]> {
  if (fromBlock > toBlock) return [];
  try {
    return await client.getLogs({ ...parameters, fromBlock, toBlock, strict: true });
  } catch (error) {
    if (fromBlock === toBlock) throw error;
    const middle = (fromBlock + toBlock) / 2n;
    return [...await readLogs(client, parameters, fromBlock, middle), ...await readLogs(client, parameters, middle + 1n, toBlock)];
  }
}
