import { expect, test } from "bun:test";
import { type Address } from "viem";
import { OpportunityManager } from "../src/execute";
import { type ExecutableOpportunity } from "../src/execution/execution-planner";
import { RUNTIME, ARBITRAGE_SEARCH_POLICY } from '../src/constants';
import { startedTestGasFees } from './helpers/gas-fees';

const pair = "0x0000000000000000000000000000000000000001" as Address;

const opportunity: ExecutableOpportunity = {
  path: [pair, pair],
  pairs: [pair],
  protocols: ["v2"],
  fees: [30],
  routeData: ["0x"],
  optimalInput: 1n,
  profit: 1n,
};

test("locks pools before an overlapping fire-and-forget submission", async () => {
  let submissions = 0;
  let releaseFirst!: () => void;
  const gasFees = await startedTestGasFees();
  const manager = new OpportunityManager({} as never, async () => {
    submissions++;
    await new Promise<void>(resolve => { releaseFirst = resolve; });
    return true;
  }, gasFees);

  try {
    const first = manager.processOpportunities({} as never, [opportunity]);
    await Promise.resolve();
    await manager.processOpportunities({} as never, [opportunity]);

    expect(submissions).toBe(1);
    releaseFirst();
    await first;
  } finally { releaseFirst?.(); manager.stop(); }
});

test('stale and expired queued opportunities are skipped before reserving or submitting', async () => {
  let submissions = 0;
  const gasFees = await startedTestGasFees();
  const manager = new OpportunityManager({} as never, async () => { submissions++; return true; }, gasFees);
  const graph = { matchesVersions: () => false } as never;
  await manager.processOpportunities(graph, [{ ...opportunity, marketVersions: { [pair]: 1 } }]);
  await manager.processOpportunities(graph, [{ ...opportunity, observedAt: Date.now() - RUNTIME.candidateMaxAgeMs - 1000 }]);
  expect(submissions).toBe(0);
  manager.stop();
});

test('off and shadow split candidates never reach submission, even through an injected submitter', async () => {
  let submissions = 0;
  const gasFees = await startedTestGasFees();
  const manager = new OpportunityManager({} as never, async () => { submissions++; return true; }, gasFees);
  const before = ARBITRAGE_SEARCH_POLICY.splitRouting;
  const split: ExecutableOpportunity = { ...opportunity, split: { mode: 'shadow', stages: [], resources: [],
    minSurplusAfterRepayment: 1n, deadline: BigInt(Math.floor(Date.now() / 1000) + 60), gasLimit: 1n, gasPriceWei: 1n, costsValidUntil: Date.now() + 60000 } };
  try {
    ARBITRAGE_SEARCH_POLICY.splitRouting = 'shadow';
    await manager.processOpportunities({} as never, [split]);
    ARBITRAGE_SEARCH_POLICY.splitRouting = 'live';
    await manager.processOpportunities({} as never, [split]);
    ARBITRAGE_SEARCH_POLICY.splitRouting = 'off';
    await manager.processOpportunities({} as never, [{ ...split, split: { ...split.split!, mode: 'live' } }]);
    expect(submissions).toBe(0);
  } finally { ARBITRAGE_SEARCH_POLICY.splitRouting = before; manager.stop(); }
});
