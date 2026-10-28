import { afterEach, expect, test } from 'bun:test';
import { decodeFunctionResult, encodeFunctionData, encodeFunctionResult, isAddress } from 'viem';
import contractAbi from '../src/ABI/UniswapFlashQuery.json';
import { CONTRACTS } from '../src/constants';
import { V3_FACTORIES } from '../src/protocols/v3/config';
import { queryBatches, readLogs } from '../src/protocols/v3/query';
import { factory, pool, v3Fixture } from './helpers/v3-fixture';

const previousAddress = CONTRACTS.flashQuery;
afterEach(() => Object.assign(CONTRACTS, { flashQuery: previousAddress }));

test('every V3 query uses the shared JSON ABI for encoding and decoding', async () => {
  Object.assign(CONTRACTS, { flashQuery: factory });
  const selected = pool();
  const fixture = v3Fixture([selected]);
  const read = fixture.client.readContract;
  fixture.client.readContract = async (request: any) => {
    expect(request.abi).toBe(contractAbi);
    expect(encodeFunctionData(request)).toMatch(/^0x[0-9a-f]+$/);
    const result = await read(request);
    const data = encodeFunctionResult({ abi: contractAbi, functionName: request.functionName, result });
    return decodeFunctionResult({ abi: contractAbi, functionName: request.functionName, data });
  };
  const cases: Array<[string, unknown[]]> = [
    ['getV3PoolMetadata', [selected.address]],
    ['getV3LiveStates', [selected.address]],
    ['getV3TickBitmapWords', [{ pool: selected.address, startWord: -1, wordCount: 1 }]],
    ['getV3Ticks', [{ pool: selected.address, ticks: [-selected.tickSpacing, 0, selected.tickSpacing] }]],
  ];
  for (const [functionName, inputs] of cases) {
    const expected = await read({ functionName, args: [inputs] });
    const result = await queryBatches(fixture.client, functionName, inputs, 1, 10n);
    // Metadata fixtures carry extra local fields which are not part of the ABI.
    expect(expected).toMatchObject(result);
  }
});

test('configured factory addresses are valid', () => {
  for (const factory of V3_FACTORIES) expect(isAddress(factory.address)).toBe(true);
});

test('query reads require a configured contract address', async () => {
  Object.assign(CONTRACTS, { flashQuery: '' });
  const fixture = v3Fixture();
  await expect(queryBatches(fixture.client, 'getV3LiveStates', [pool().address], 1, 10n)).rejects.toThrow('UNISWAP_FLASH_QUERY_CONTRACT_ADDRESS is required');
  expect(fixture.calls).toEqual([]);
});

test('query and log batches shrink when the provider rejects large ranges', async () => {
  const fixture = v3Fixture();
  fixture.client.readContract = async (request: any) => {
    if (request.args[0].length > 1) throw new Error('batch too large');
    expect(request.blockNumber).toBe(10n);
    return request.args[0];
  };
  expect(await queryBatches(fixture.client, 'getV3LiveStates', [1, 2, 3], 3, 10n)).toEqual([1, 2, 3]);
  fixture.client.getLogs = async ({ fromBlock, toBlock }: any) => {
    if (fromBlock !== toBlock) throw new Error('range too large');
    return [{ blockNumber: fromBlock }];
  };
  expect(await readLogs(fixture.client, { address: factory }, 1n, 3n)).toEqual([{ blockNumber: 1n }, { blockNumber: 2n }, { blockNumber: 3n }]);
});
