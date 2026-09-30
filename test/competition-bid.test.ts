import { afterEach, expect, test } from 'bun:test';
import { type Hex } from 'viem';
import { ARBITRAGE_SEARCH_POLICY, CONTRACTS, EXECUTION_POLICY } from '../src/constants';
import { OpportunityManager } from '../src/execute';
import { type ExecutableOpportunity, type FlashPoolLookup } from '../src/execution/execution-planner';
import { GasFees, withCompetitionBid, type GasFeeSnapshot } from '../src/execution/gas-fees';
import { type NetworkConfig } from '../src/network';
import { address } from './helpers/markets';
import { readExecutorContract } from './helpers/execution';

const saved = { ...EXECUTION_POLICY };
const savedContract = CONTRACTS.arbitrage;
afterEach(() => { Object.assign(EXECUTION_POLICY, saved); Object.assign(CONTRACTS, { arbitrage: savedContract }); });

const legacyFees: GasFeeSnapshot = { type: 'legacy', gasPrice: 500n, validUntil: Number.MAX_SAFE_INTEGER };
const eip1559Fees: GasFeeSnapshot = { type: 'eip1559', maxFeePerGas: 500n, maxPriorityFeePerGas: 3n, validUntil: Number.MAX_SAFE_INTEGER };
const floor = ARBITRAGE_SEARCH_POLICY.minProfitNative!;

test('the bid adds the profit share per gas to legacy price or to both EIP-1559 fields', () => {
  expect(withCompetitionBid(legacyFees, 6_000_000_000n, 1_500_000n, 25)).toMatchObject({ gasPrice: 1_500n });
  expect(withCompetitionBid(eip1559Fees, 6_000_000_000n, 1_500_000n, 25)).toMatchObject({ maxFeePerGas: 1_500n, maxPriorityFeePerGas: 1_003n });
  expect(withCompetitionBid(legacyFees, 6_000_000_000n, 1_500_000n, 0)).toBe(legacyFees);
  expect(withCompetitionBid(eip1559Fees, 0n, 1_500_000n, 25)).toBe(eip1559Fees);
  expect(withCompetitionBid(legacyFees, -1n, 1_500_000n, 100)).toBe(legacyFees);
});

async function submit(legacy: boolean, opportunities: ExecutableOpportunity[]) {
  Object.assign(CONTRACTS, { arbitrage: address(900) });
  const signed: Array<{ gas: bigint; gasPrice?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; type: string }> = [];
  const fees = new GasFees(async type => type === 'legacy' ? { gasPrice: 500n } : { maxFeePerGas: 500n, maxPriorityFeePerGas: 3n },
    { ...EXECUTION_POLICY, legacy, feeRefreshIntervalMs: 300_000, feeCeilingPerGas: 1_000n });
  await fees.start();
  const manager = new OpportunityManager({
    account: { type: 'local', address: address(999), signTransaction: async (tx: typeof signed[number]) => { signed.push(tx); return '0x01' as Hex; } },
    client: { readContract: readExecutorContract, getTransactionCount: async () => 7 },
    walletClient: { sendRawTransaction: async () => `0x${'0'.repeat(64)}` },
  } as unknown as NetworkConfig, undefined, fees);
  const lookup: FlashPoolLookup = { matchesVersions: () => true,
    findBestFlashPoolForToken: () => ({ protocol: 'v2', poolAddress: address(102), fee: 30, liquidity: 100000n }) };
  try {
    await manager.start();
    await manager.processOpportunities(lookup, opportunities);
  } finally { manager.stop(); fees.stop(); }
  return signed;
}

const opportunity = (pair: number, surplus: bigint): ExecutableOpportunity => ({ path: [address(100), address(100)], pairs: [address(pair)],
  protocols: ['v2'], fees: [30], routeData: ['0x'], optimalInput: 1000n, profit: 100n, flashPoolAddress: address(102),
  netProfitNative: floor + surplus });

for (const legacy of [true, false]) {
  test(`a ${legacy ? 'legacy' : 'EIP-1559'} submission bids 25% of surplus above the normal price and past the fee ceiling`, async () => {
    Object.assign(EXECUTION_POLICY, { submissionMode: 'single', competitionProfitSharePercent: 25 });
    const [tx] = await submit(legacy, [opportunity(101, 6_000_000_000n)]);
    expect(tx.gas).toBe(1_500_000n);
    if (legacy) expect(tx).toMatchObject({ type: 'legacy', gasPrice: 1_500n });
    else expect(tx).toMatchObject({ type: 'eip1559', maxFeePerGas: 1_500n, maxPriorityFeePerGas: 1_003n });
  });

  test(`a ${legacy ? 'legacy' : 'EIP-1559'} submission keeps the normal price at 0%`, async () => {
    Object.assign(EXECUTION_POLICY, { submissionMode: 'single', competitionProfitSharePercent: 0 });
    const [tx] = await submit(legacy, [opportunity(101, 6_000_000_000n)]);
    if (legacy) expect(tx.gasPrice).toBe(500n);
    else expect(tx).toMatchObject({ maxFeePerGas: 500n, maxPriorityFeePerGas: 3n });
  });
}

test('a batch bids on the combined surplus over the batch gas limit', async () => {
  Object.assign(EXECUTION_POLICY, { submissionMode: 'batch', competitionProfitSharePercent: 25 });
  const signed = await submit(true, [opportunity(101, 6_000_000_000n), opportunity(103, 12_000_000_000n)]);
  expect(signed).toHaveLength(1);
  expect(signed[0].gas).toBe(EXECUTION_POLICY.gasLimits.batch);
  expect(signed[0].gasPrice).toBe(500n + 18_000_000_000n * 25n / 100n / EXECUTION_POLICY.gasLimits.batch);
});

test('an opportunity at or below its profit floor gets no extra gas', async () => {
  Object.assign(EXECUTION_POLICY, { submissionMode: 'single', competitionProfitSharePercent: 100 });
  const [tx] = await submit(true, [{ ...opportunity(101, 0n), netProfitNative: floor }]);
  expect(tx.gasPrice).toBe(500n);
});

for (const share of [-1, 101, 12.5]) test(`startup rejects competitionProfitSharePercent ${share}`, async () => {
  Object.assign(EXECUTION_POLICY, { competitionProfitSharePercent: share });
  const manager = new OpportunityManager({ client: { readContract: readExecutorContract } } as unknown as NetworkConfig,
    undefined, new GasFees(async () => ({ gasPrice: 1n })));
  await expect(manager.start()).rejects.toThrow('competitionProfitSharePercent');
});
