import { expect, test } from "bun:test";
import { type Address } from "viem";
import { OpportunityManager } from "../src/execute";
import { type ExecutableOpportunity } from "../src/execution/execution-planner";
import { RUNTIME, ARBITRAGE_SEARCH_POLICY, EXECUTION_POLICY } from '../src/constants';
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

test('off blocks an otherwise eligible split, while live permits submission', async () => {
  let submissions = 0;
  const gasFees = await startedTestGasFees();
  const manager = new OpportunityManager({} as never, async () => { submissions++; return true; }, gasFees);
  const before = ARBITRAGE_SEARCH_POLICY.splitRouting;
  const split: ExecutableOpportunity = { ...opportunity, observedAt: Date.now(), marketVersions: { [pair]: 1 },
    split: { stages: [], resources: [],
      deadline: BigInt(Math.floor(Date.now() / 1000) + 60), gasLimit: EXECUTION_POLICY.gasLimit,
      gasPriceWei: 500n, costsValidUntil: Date.now() + 60000 } };
  const graph = { matchesVersions: () => true } as never;
  try {
    ARBITRAGE_SEARCH_POLICY.splitRouting = 'off';
    await manager.processOpportunities(graph, [split]);
    expect(submissions).toBe(0);
    ARBITRAGE_SEARCH_POLICY.splitRouting = 'live';
    await manager.processOpportunities(graph, [split]);
    expect(submissions).toBe(1);
  } finally { ARBITRAGE_SEARCH_POLICY.splitRouting = before; manager.stop(); }
});
