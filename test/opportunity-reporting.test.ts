import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { EXECUTION_POLICY, RUNTIME, TOKENS } from '../src/constants';
import { OpportunityEngine } from '../src/opportunities/opportunity-engine';
import { createOpportunityScanner } from '../src/opportunities/opportunity-workflow';
import { WorkerSearch } from '../src/opportunities/worker-search';
import { logger } from '../src/reporting/logger';
import { formatReport } from '../src/reporting/records';
import { type NetworkConfig } from '../src/network';

const originalLevel = RUNTIME.logLevel;
const originalExecution = EXECUTION_POLICY.executeTrades;
const network = { client: { estimateFeesPerGas: async () => ({
  maxFeePerGas: 500n * 10n ** 9n, maxPriorityFeePerGas: 3n * 10n ** 9n,
}) } } as unknown as NetworkConfig;

afterEach(() => {
  Object.assign(RUNTIME, { logLevel: originalLevel });
  Object.assign(EXECUTION_POLICY, { executeTrades: originalExecution });
  mock.restore();
});

test('reports a profitable worker result that aged out without treating it as executable', async () => {
  Object.assign(RUNTIME, { logLevel: 'debug' });
  Object.assign(EXECUTION_POLICY, { executeTrades: false });
  const engine = new OpportunityEngine();
  const token = TOKENS[0].address;
  spyOn(Date, 'now').mockReturnValue(1_000);
  const result = {
    path: [token, token], pairs: [], edgeIds: [], protocols: [], fees: [], routeData: [],
    profit: 10n ** 18n, optimalInput: 10n ** 18n,
    marketVersions: engine.graph.marketVersions([]), observedAt: 1_000 - RUNTIME.candidateMaxAgeMs - 100,
  };
  spyOn(WorkerSearch.prototype, 'search').mockResolvedValue([result]);
  const messages: string[] = [];
  spyOn(logger, 'info').mockImplementation((...args) => { messages.push(formatReport({ at: 0, level: 'info', args })); });
  spyOn(logger, 'debug').mockImplementation((...args) => { messages.push(formatReport({ at: 0, level: 'debug', args })); });

  const scanner = await createOpportunityScanner(engine, network);
  try {
    expect(await scanner.scan()).toEqual([]);
  } finally {
    scanner.stop();
  }
  const output = messages.join('\n');
  expect(output).toContain('1 expired');
  expect(output).toContain('Quoted profit:');
  expect(output).toContain('Age at check:');
  expect(output).not.toContain('No profitable arbitrage opportunities found');
});

test('keeps a fresh quote eligible and separately reports a changed market', async () => {
  Object.assign(RUNTIME, { logLevel: 'debug' });
  Object.assign(EXECUTION_POLICY, { executeTrades: false });
  spyOn(Date, 'now').mockReturnValue(1_000);
  const engine = new OpportunityEngine();
  const token = TOKENS[0].address;
  const result = {
    path: [token, token], pairs: [], edgeIds: [], protocols: [], fees: [], routeData: [],
    profit: 10n ** 18n, optimalInput: 10n ** 18n,
    marketVersions: engine.graph.marketVersions([]), observedAt: 900,
  };
  spyOn(WorkerSearch.prototype, 'search').mockResolvedValue([result]);
  const messages: string[] = [];
  spyOn(logger, 'info').mockImplementation((...args) => { messages.push(formatReport({ at: 0, level: 'info', args })); });
  spyOn(logger, 'debug').mockImplementation((...args) => { messages.push(formatReport({ at: 0, level: 'debug', args })); });

  const scanner = await createOpportunityScanner(engine, network);
  try {
    expect(await scanner.scan()).toEqual([result]);
    engine.graph.setFeedReady(false);
    expect(await scanner.scan()).toEqual([]);
  } finally {
    scanner.stop();
  }
  const output = messages.join('\n');
  expect(output).toContain('1 eligible, 0 expired, 0 invalidated');
  expect(output).toContain('0 eligible, 0 expired, 1 invalidated');
  expect(output).toContain('market changed or feed unavailable; not executable');
});
