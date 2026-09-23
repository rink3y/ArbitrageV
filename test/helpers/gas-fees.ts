import { EXECUTION_POLICY } from '../../src/constants';
import { GasFees } from '../../src/execution/gas-fees';

export async function startedTestGasFees(): Promise<GasFees> {
  const fees = new GasFees(async type => type === 'legacy'
    ? { gasPrice: 500n }
    : { maxFeePerGas: 500n, maxPriorityFeePerGas: 3n },
  { ...EXECUTION_POLICY, feeRefreshIntervalMs: 300_000, feeCeilingPerGas: 1_000n });
  await fees.start();
  return fees;
}
