import { expect, test } from 'bun:test';
import { decodeFunctionData, parseTransaction, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { OpportunityManager } from '../src/execute';
import { CONTRACTS, ARBITRAGE_SEARCH_POLICY, TELEGRAM, EXECUTION_POLICY } from '../src/constants';
import { type ExecutableOpportunity } from '../src/execution/execution-planner';
import { type NetworkConfig } from '../src/network';
import { GasFees } from '../src/execution/gas-fees';
import ArbABI from '../src/ABI/Arb.json';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const;
test('a live split signs one staged transaction with one local nonce and locks every branch', async () => {
  const old = { mode: ARBITRAGE_SEARCH_POLICY.splitRouting, contract: CONTRACTS.arbitrage, telegram: TELEGRAM.botToken };
  const submitted: Hex[] = [];
  let nonceReads = 0;
  let feeReads = 0;
  const gasFees = new GasFees(async () => { feeReads++; return { maxFeePerGas: 500n, maxPriorityFeePerGas: 3n }; },
    { ...EXECUTION_POLICY, feeMode: 'auto', feeRefreshIntervalMs: 300_000, autoMaxFeePerGas: 1_000n });
  const manager = new OpportunityManager({ account: privateKeyToAccount(`0x${'1'.padStart(64, '0')}`),
    client: { getTransactionCount: async () => { nonceReads++; return 7; } },
    walletClient: { sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      submitted.push(serializedTransaction); return `0x${'0'.repeat(64)}`;
    } },
  } as unknown as NetworkConfig, undefined, gasFees);
  const opportunity: ExecutableOpportunity = { path: [addr(1), addr(2), addr(1)], pairs: [addr(3), addr(4), addr(5)],
    protocols: ['v2', 'v2', 'v2'], fees: [0, 0, 0], routeData: ['0x', '0x', '0x'], optimalInput: 200n, profit: 106n,
    netProfit: 100n, observedAt: Date.now(), marketVersions: { [addr(3)]: 1 }, flashPoolAddress: addr(6),
    split: { mode: 'live', resources: [addr(3), addr(4), addr(5)], minSurplusAfterRepayment: 100n,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 30), costsValidUntil: Date.now() + 30000,
      gasLimit: EXECUTION_POLICY.gasLimit, gasPriceWei: 500n,
      stages: [
        { tokenIn: addr(1), tokenOut: addr(2), branches: [3, 4].map(n => ({ pool: addr(n), protocol: 'v2' as const,
          fee: 0, data: '0x' as const, amountIn: 100n, minAmountOut: 181n })) },
        { tokenIn: addr(2), tokenOut: addr(1), branches: [{ pool: addr(5), protocol: 'v2', fee: 0, data: '0x', amountIn: 362n, minAmountOut: 306n }] },
      ] } };
  const lookup = { matchesVersions: () => true, findBestFlashPoolForToken: () => ({ protocol: 'v2' as const, poolAddress: addr(6), fee: 0, liquidity: 100000n }) };
  try {
    ARBITRAGE_SEARCH_POLICY.splitRouting = 'live'; Object.assign(CONTRACTS, { arbitrage: addr(9) }); Object.assign(TELEGRAM, { botToken: '' });
    await gasFees.start();
    await manager.start();
    await manager.processOpportunities(lookup, [opportunity]);
    expect(submitted.length).toBe(1);
    const transaction = parseTransaction(submitted[0]);
    expect(transaction.nonce).toBe(7);
    expect(transaction.gas).toBe(EXECUTION_POLICY.gasLimit);
    expect(transaction.maxFeePerGas).toBe(500n);
    expect(transaction.maxPriorityFeePerGas).toBe(3n);
    const decoded = decodeFunctionData({ abi: ArbABI, data: transaction.data! });
    expect(decoded.functionName).toBe('executeSplitArbitrage');
    expect((decoded.args![0] as any).stages[0].branches.map((branch: any) => branch.amountIn)).toEqual([100n, 100n]);
    await manager.processOpportunities(lookup, [{ ...opportunity, split: undefined, pairs: [addr(4)], protocols: ['v2'], fees: [0], routeData: ['0x'] }]);
    expect(submitted.length).toBe(1);
    expect(nonceReads).toBe(1);
    expect(feeReads).toBe(1);
    manager.releasePairs(opportunity.pairs);
    await manager.processOpportunities(lookup, [{ ...opportunity, split: { ...opportunity.split!, costsValidUntil: Date.now() - 1 } }]);
    expect(submitted.length).toBe(1);
  } finally {
    manager.stop(); gasFees.stop(); ARBITRAGE_SEARCH_POLICY.splitRouting = old.mode; Object.assign(CONTRACTS, { arbitrage: old.contract }); Object.assign(TELEGRAM, { botToken: old.telegram });
  }
});
