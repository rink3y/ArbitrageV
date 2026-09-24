import { expect, test } from 'bun:test';
import { ARBITRAGE_SEARCH_POLICY, RUNTIME, TOKENS } from '../src/constants';
import { OpportunityEngine } from '../src/opportunities/opportunity-engine';
import { WorkerSearch } from '../src/opportunities/worker-search';
import { estimateTransfer, type TokenTransferProfile } from '../src/protocols/v2/transfer-fees';
import { type Address } from 'viem';

test('off/info/debug preserve real local and worker quotes with the tax safety gate enabled', async () => {
  const previous = RUNTIME.logLevel;
  const [a, b, c] = TOKENS.map(token => token.address);
  const engine = new OpportunityEngine({ ...ARBITRAGE_SEARCH_POLICY, allowedProtocols: ['v2'],
    maxRouteEdges: 3, beamWidth: 8, splitRouting: 'off' });
  const now = Date.now();
  const profile = (token: Address, pool: Address): TokenTransferProfile => {
    const estimate = estimateTransfer([1n, 10n ** 30n].map(requested => ({ requested, debited: requested, credited: requested })));
    return { token, pool, executor: a, origin: a, recipient: a, blockNumber: 1n, observedAt: now, validUntil: now + 60_000,
      buy: estimate, sell: estimate, transfer: estimate };
  };
  for (const [index, token0, token1] of [[1, a, b], [2, b, c], [3, c, a], [4, a, b]] as const) {
    const pool: Address = `0x${index.toString(16).padStart(40, '0')}`;
    engine.graph.addPair({ pairAddress: pool, token0, token1, reserve0: 10n ** 24n, reserve1: 2n * 10n ** 24n,
      fee: 30, variant: 'uniswap-v2', scale0: 1n, scale1: 1n,
      transferProfiles: { token0: profile(token0, pool), token1: profile(token1, pool) } });
  }
  const request = { startTokens: [a], observedAt: now };
  const expected = engine.findOpportunities(request);
  expect(expected.length).toBeGreaterThan(0);
  const worker = new WorkerSearch(engine.graph, engine.policy, engine.tokens);
  try {
    for (const level of ['off', 'info', 'debug'] as const) {
      RUNTIME.logLevel = level;
      expect(engine.findOpportunities(request)).toEqual(expected);
      expect(engine.diagnostics.length > 0).toBe(level === 'debug');
      expect(await worker.search(request)).toEqual(expected);
    }
  } finally { RUNTIME.logLevel = previous; worker.stop(); }
});
