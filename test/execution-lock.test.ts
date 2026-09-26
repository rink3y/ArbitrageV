import { expect, test } from "bun:test";
import { type Address } from "viem";
import { OpportunityManager } from "../src/execute";
import { type ExecutableOpportunity } from "../src/execution/execution-planner";
import { RUNTIME, ARBITRAGE_SEARCH_POLICY, EXECUTION_POLICY, CONTRACTS } from '../src/constants';
import { startedTestGasFees, readExecutorContract } from './helpers/execution';

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

test('disjoint routes may share a flash lender while swapped pools stay locked', async () => {
  let submissions = 0;
  const fees = await startedTestGasFees();
  const manager = new OpportunityManager({} as never, async () => { submissions++; return true; }, fees);
  const secondPair = '0x0000000000000000000000000000000000000002' as Address;
  const lender = '0x0000000000000000000000000000000000000003' as Address;
  try {
    await manager.processOpportunities({} as never, [
      { ...opportunity, flashPoolAddress: lender },
      { ...opportunity, pairs: [secondPair], flashPoolAddress: lender },
    ]);
    expect(submissions).toBe(2);
    await manager.processOpportunities({} as never, [opportunity]);
    expect(submissions).toBe(2); // Swapped pools stay locked.
  } finally { manager.stop(); }
});

test('off blocks an otherwise eligible split, while live permits submission', async () => {
  let submissions = 0;
  const gasFees = await startedTestGasFees();
  const manager = new OpportunityManager({} as never, async () => { submissions++; return true; }, gasFees);
  const before = ARBITRAGE_SEARCH_POLICY.splitRouting;
  const split: ExecutableOpportunity = { ...opportunity, observedAt: Date.now(), marketVersions: { [pair]: 1 },
    split: { stages: [], resources: [],
      deadline: BigInt(Math.floor(Date.now() / 1000) + 60), gasLimit: EXECUTION_POLICY.gasLimits.single,
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

test('route flash checks the deployed executor once before starting', async () => {
  const oldAddress = CONTRACTS.arbitrage;
  const oldEnabled = EXECUTION_POLICY.routeSwapFunding;
  Object.assign(CONTRACTS, { arbitrage: pair });
  Object.assign(EXECUTION_POLICY, { routeSwapFunding: true });
  let reads = 0;
  const manager = new OpportunityManager({ client: {
    readContract: async () => { reads++; return '0x0000000000000000000000000000000000000000'; },
  } } as never);
  try {
    await expect(manager.start()).rejects.toThrow('does not expose the protocol modules');
    expect(reads).toBe(1);
  } finally {
    manager.stop();
    Object.assign(CONTRACTS, { arbitrage: oldAddress });
    Object.assign(EXECUTION_POLICY, { routeSwapFunding: oldEnabled });
  }
});

test('batch startup rejects an old executor before warming fees or nonces', async () => {
  const oldAddress = CONTRACTS.arbitrage, oldMode = EXECUTION_POLICY.submissionMode;
  Object.assign(CONTRACTS, { arbitrage: pair }); Object.assign(EXECUTION_POLICY, { submissionMode: 'batch' });
  const manager = new OpportunityManager({ client: {
    readContract: async (args: { functionName: string }) => args.functionName === 'MAX_BATCH_PLANS' ? 0n : readExecutorContract(args),
    estimateFeesPerGas: async () => { throw Error('fee RPC must not run'); },
    getTransactionCount: async () => { throw Error('nonce RPC must not run'); },
  } } as never);
  try {
    await expect(manager.start()).rejects.toThrow('Deploy NArb with independent batch support');
  } finally {
    manager.stop(); Object.assign(CONTRACTS, { arbitrage: oldAddress }); Object.assign(EXECUTION_POLICY, { submissionMode: oldMode });
  }
});
