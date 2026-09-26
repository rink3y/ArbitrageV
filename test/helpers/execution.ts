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


// The executor's startup capability checks are separate from nonce and fee reads.
export async function readExecutorContract({ functionName }: { functionName: string }) {
  if (functionName === 'approvedWrapper') return true;
  if (functionName === 'v2Logic') return '0x0000000000000000000000000000000000000320';
  throw new Error('Unexpected executor read: ' + functionName);
}
