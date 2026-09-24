import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { ARBITRAGE_SEARCH_POLICY, EXECUTION_POLICY, RUNTIME, TOKENS } from '../src/constants';
import { LocalNonces } from '../src/execution/local-nonces';
import { OpportunityManager } from '../src/execute';
import { type NetworkConfig } from '../src/network';
import { OpportunityEngine } from '../src/opportunities/opportunity-engine';
import { type ArbitrageOpportunity } from '../src/opportunities/opportunity-types';
import { createOpportunityScanner } from '../src/opportunities/opportunity-workflow';
import { WorkerSearch } from '../src/opportunities/worker-search';
import { logger } from '../src/reporting/logger';
import { formatReport } from '../src/reporting/records';

const originalExecution = EXECUTION_POLICY.executeTrades;
const originalLevel = RUNTIME.logLevel;
const token = TOKENS[0].address;
const estimate = () => Promise.resolve({ gasPrice: 500n, maxFeePerGas: 500n, maxPriorityFeePerGas: 3n });
function network(read = async () => 7): NetworkConfig {
  return { account: { address: token }, client: { getTransactionCount: read, estimateFeesPerGas: estimate } } as unknown as NetworkConfig;
}
afterEach(() => {
  Object.assign(EXECUTION_POLICY, { executeTrades: originalExecution });
  RUNTIME.logLevel = originalLevel;
  mock.restore();
});

test('scanner creation waits for the pending nonce and owns timer cleanup', async () => {
  Object.assign(EXECUTION_POLICY, { executeTrades: true });
  let resolve!: (nonce: number) => void;
  const read = mock(() => new Promise<number>(done => { resolve = done; }));
  const stop = spyOn(LocalNonces.prototype, 'stop');
  let ready = false;
  const creation = createOpportunityScanner(new OpportunityEngine(), network(read)).then(scanner => {
    ready = true;
    return scanner;
  });
  while (read.mock.calls.length === 0) await new Promise(resolve => setImmediate(resolve));
  expect(ready).toBe(false);
  expect(read).toHaveBeenCalledWith({ address: token, blockTag: 'pending' });
  resolve(7);
  const scanner = await creation;
  scanner.stop();
  expect(ready).toBe(true);
  expect(stop).toHaveBeenCalledTimes(1);
});

test('fee refresh happens at startup, not on each search', async () => {
  Object.assign(EXECUTION_POLICY, { executeTrades: false });
  const read = mock(estimate);
  const scanner = await createOpportunityScanner(new OpportunityEngine(), {
    client: { estimateFeesPerGas: read },
  } as unknown as NetworkConfig);
  try {
    await scanner.scan();
    await scanner.scan();
    expect(read).toHaveBeenCalledTimes(1);
  } finally { scanner.stop(); }
});

test('a failed nonce warmup rejects startup and cancels background retries', async () => {
  Object.assign(EXECUTION_POLICY, { executeTrades: true });
  const stop = spyOn(LocalNonces.prototype, 'stop');
  await expect(createOpportunityScanner(new OpportunityEngine(), network(async () => {
    throw new Error('RPC offline');
  }))).rejects.toThrow('RPC offline');
  expect(stop).toHaveBeenCalledTimes(1);
});

function quotedScanner(observedAt = 900) {
  Object.assign(EXECUTION_POLICY, { executeTrades: false });
  RUNTIME.logLevel = 'debug';
  spyOn(Date, 'now').mockReturnValue(1000);
  const engine = new OpportunityEngine({ ...ARBITRAGE_SEARCH_POLICY, splitRouting: 'live' });
  const quote: ArbitrageOpportunity = {
    path: [token, token], pairs: [], edgeIds: [], protocols: [], fees: [], routeData: [],
    profit: 10n ** 18n, optimalInput: 10n ** 18n, flashPoolAddress: token,
    marketVersions: engine.graph.marketVersions([]), observedAt,
  };
  const search = spyOn(WorkerSearch.prototype, 'search').mockResolvedValue([quote]);
  const messages: string[] = [];
  for (const level of ['info', 'debug'] as const) spyOn(logger, level).mockImplementation((...args) => {
    messages.push(formatReport({ at: 0, level, args }));
  });
  return { engine, quote, search, messages };
}

test('reports a profitable worker result that aged out without treating it as executable', async () => {
  const f = quotedScanner(1000 - RUNTIME.candidateMaxAgeMs - 100);
  const scanner = await createOpportunityScanner(f.engine, network());
  try { expect(await scanner.scan()).toEqual([]); }
  finally { scanner.stop(); }
  const output = f.messages.join('\n');
  expect(output).toContain('1 expired');
  expect(output).toContain('Quoted profit:');
  expect(output).toContain('Age at check:');
  expect(output).not.toContain('No profitable arbitrage opportunities found');
});

test('keeps a fresh quote eligible and separately reports a changed market', async () => {
  const f = quotedScanner();
  const scanner = await createOpportunityScanner(f.engine, network());
  try {
    expect(await scanner.scan()).toEqual([f.quote]);
    f.engine.graph.setFeedReady(false);
    expect(await scanner.scan()).toEqual([]);
  } finally { scanner.stop(); }
  const output = f.messages.join('\n');
  expect(output).toContain('1 eligible, 0 expired, 0 invalidated');
  expect(output).toContain('0 eligible, 0 expired, 1 invalidated');
  expect(output).toContain('market changed or feed unavailable; not executable');
});

test('live search with executeTrades false reports both route types without starting execution or nonces', async () => {
  const f = quotedScanner();
  const split: ArbitrageOpportunity = { ...f.quote, split: { stages: [], resources: [],
    minSurplusAfterRepayment: 1n, deadline: 60n, gasLimit: EXECUTION_POLICY.gasLimit,
    gasPriceWei: 500n, costsValidUntil: 60000 } };
  f.search.mockResolvedValue([f.quote, split]);
  const start = spyOn(OpportunityManager.prototype, 'start').mockResolvedValue();
  const nonces = spyOn(LocalNonces.prototype, 'start');
  const submit = spyOn(OpportunityManager.prototype, 'processOpportunities').mockResolvedValue();
  // No account, wallet or RPC transport exists in this fixture.
  const scanner = await createOpportunityScanner(f.engine, { client: { estimateFeesPerGas: estimate } } as unknown as NetworkConfig);
  try {
    expect(await scanner.scan()).toEqual([f.quote, split]);
    expect(f.search).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    expect(nonces).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  } finally { scanner.stop(); }
});
