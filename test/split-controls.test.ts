import { expect, mock, spyOn, test } from 'bun:test';
import { ARBITRAGE_SEARCH_POLICY, EXECUTION_POLICY, TOKENS } from '../src/constants';
import { OpportunityManager } from '../src/execute';
import { type NetworkConfig } from '../src/network';
import { OpportunityEngine } from '../src/opportunities/opportunity-engine';
import { type ArbitrageOpportunity } from '../src/opportunities/opportunity-types';
import { createOpportunityScanner } from '../src/opportunities/opportunity-workflow';
import { WorkerSearch } from '../src/opportunities/worker-search';

test('live search with executeTrades false reports direct and split quotes without starting execution', async () => {
  const previous = EXECUTION_POLICY.executeTrades;
  Object.assign(EXECUTION_POLICY, { executeTrades: false });
  const engine = new OpportunityEngine({ ...ARBITRAGE_SEARCH_POLICY, splitRouting: 'live' });
  const token = TOKENS[0].address;
  const direct: ArbitrageOpportunity = {
    path: [token, token], pairs: [token], edgeIds: [], protocols: ['v2'], fees: [30], routeData: ['0x'],
    optimalInput: 1n, profit: 2n, observedAt: Date.now(), marketVersions: { [token]: 1 }, flashPoolAddress: token,
  };
  const split: ArbitrageOpportunity = { ...direct, split: { stages: [], resources: [],
    minSurplusAfterRepayment: 1n, deadline: BigInt(Math.floor(Date.now() / 1000) + 60),
    gasLimit: EXECUTION_POLICY.gasLimit, gasPriceWei: 500n, costsValidUntil: Date.now() + 60000 } };
  const search = spyOn(WorkerSearch.prototype, 'search').mockResolvedValue([direct, split]);
  const versions = spyOn(engine.graph, 'matchesVersions').mockReturnValue(true);
  const start = spyOn(OpportunityManager.prototype, 'start').mockResolvedValue();
  const submit = spyOn(OpportunityManager.prototype, 'processOpportunities').mockResolvedValue();
  const feeRead = mock(async () => ({ gasPrice: 500n, maxFeePerGas: 500n, maxPriorityFeePerGas: 3n }));
  let scanner: Awaited<ReturnType<typeof createOpportunityScanner>> | undefined;
  try {
    // No account, wallet or RPC transport exists in this fixture.
    scanner = await createOpportunityScanner(engine, { client: { estimateFeesPerGas: feeRead } } as unknown as NetworkConfig);
    expect(await scanner.scan()).toEqual([direct, split]);
    expect(search).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  } finally {
    scanner?.stop();
    Object.assign(EXECUTION_POLICY, { executeTrades: previous });
    search.mockRestore(); versions.mockRestore(); start.mockRestore(); submit.mockRestore();
  }
});
