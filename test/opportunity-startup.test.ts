import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { EXECUTION_POLICY } from '../src/constants';
import { LocalNonces } from '../src/execution/local-nonces';
import { type NetworkConfig } from '../src/network';
import { OpportunityEngine } from '../src/opportunities/opportunity-engine';
import { createOpportunityScanner } from '../src/opportunities/opportunity-workflow';

const originalExecution = EXECUTION_POLICY.executeTrades;
afterEach(() => {
  Object.assign(EXECUTION_POLICY, { executeTrades: originalExecution });
  mock.restore();
});

test('scanner creation waits for the pending nonce and owns timer cleanup', async () => {
  Object.assign(EXECUTION_POLICY, { executeTrades: true });
  let resolve!: (nonce: number) => void;
  const read = mock(() => new Promise<number>(done => { resolve = done; }));
  const stop = spyOn(LocalNonces.prototype, 'stop');
  const network = {
    account: { address: '0x0000000000000000000000000000000000000001' },
    client: { getTransactionCount: read, estimateFeesPerGas: async () => ({ maxFeePerGas: 500n * 10n ** 9n, maxPriorityFeePerGas: 3n * 10n ** 9n }) },
  } as unknown as NetworkConfig;
  let ready = false;
  const creation = createOpportunityScanner(new OpportunityEngine(), network).then(scanner => {
    ready = true;
    return scanner;
  });
  while (read.mock.calls.length === 0) await new Promise(resolve => setImmediate(resolve));
  expect(ready).toBe(false);
  expect(read).toHaveBeenCalledWith({ address: network.account.address, blockTag: 'pending' });
  resolve(7);
  const scanner = await creation;
  scanner.stop();
  expect(ready).toBe(true);
  expect(stop).toHaveBeenCalledTimes(1);
});

test('watch-only mode does not start a nonce allocator', async () => {
  Object.assign(EXECUTION_POLICY, { executeTrades: false });
  const start = spyOn(LocalNonces.prototype, 'start');
  const network = { client: { estimateFeesPerGas: async () => ({ maxFeePerGas: 500n * 10n ** 9n, maxPriorityFeePerGas: 3n * 10n ** 9n }) } } as unknown as NetworkConfig;
  const scanner = await createOpportunityScanner(new OpportunityEngine(), network);
  scanner.stop();
  expect(start).not.toHaveBeenCalled();
});

test('fee refresh happens at startup, not on each search', async () => {
  Object.assign(EXECUTION_POLICY, { executeTrades: false });
  const estimate = mock(async () => ({ maxFeePerGas: 500n * 10n ** 9n, maxPriorityFeePerGas: 3n * 10n ** 9n }));
  const network = { client: { estimateFeesPerGas: estimate } } as unknown as NetworkConfig;
  const scanner = await createOpportunityScanner(new OpportunityEngine(), network);
  try {
    await scanner.scan();
    await scanner.scan();
    expect(estimate).toHaveBeenCalledTimes(1);
  } finally { scanner.stop(); }
});

test('a failed nonce warmup rejects startup and cancels background retries', async () => {
  Object.assign(EXECUTION_POLICY, { executeTrades: true });
  const stop = spyOn(LocalNonces.prototype, 'stop');
  const network = {
    account: { address: '0x0000000000000000000000000000000000000001' },
    client: { getTransactionCount: async () => { throw new Error('RPC offline'); },
      estimateFeesPerGas: async () => ({ maxFeePerGas: 500n * 10n ** 9n, maxPriorityFeePerGas: 3n * 10n ** 9n }) },
  } as unknown as NetworkConfig;
  await expect(createOpportunityScanner(new OpportunityEngine(), network)).rejects.toThrow('RPC offline');
  expect(stop).toHaveBeenCalledTimes(1);
});
