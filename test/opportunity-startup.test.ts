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
    client: { getTransactionCount: read },
  } as unknown as NetworkConfig;
  let ready = false;
  const creation = createOpportunityScanner(new OpportunityEngine(), network).then(scanner => {
    ready = true;
    return scanner;
  });
  await Promise.resolve();
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
  const scanner = await createOpportunityScanner(new OpportunityEngine(), {} as NetworkConfig);
  scanner.stop();
  expect(start).not.toHaveBeenCalled();
});

test('a failed nonce warmup rejects startup and cancels background retries', async () => {
  Object.assign(EXECUTION_POLICY, { executeTrades: true });
  const stop = spyOn(LocalNonces.prototype, 'stop');
  const network = {
    account: { address: '0x0000000000000000000000000000000000000001' },
    client: { getTransactionCount: async () => { throw new Error('RPC offline'); } },
  } as unknown as NetworkConfig;
  await expect(createOpportunityScanner(new OpportunityEngine(), network)).rejects.toThrow('RPC offline');
  expect(stop).toHaveBeenCalledTimes(1);
});
