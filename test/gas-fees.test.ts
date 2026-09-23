import { expect, spyOn, test } from 'bun:test';
import { EXECUTION_POLICY } from '../src/constants';
import { GasFees, gasPriceCeiling } from '../src/execution/gas-fees';

const policy = { ...EXECUTION_POLICY, feeMode: 'auto' as const,
  feeRefreshIntervalMs: 10, autoMaxFeePerGas: 1_000n };

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 2));
  expect(check()).toBe(true);
}

test('manual fees do not read the network and remain the same snapshot', async () => {
  let reads = 0;
  const fees = new GasFees(async () => { reads++; throw new Error('must not read'); },
    { ...policy, feeMode: 'manual' });
  try {
    await fees.start();
    expect(reads).toBe(0);
    expect(fees.current()?.type).toBe('eip1559');
    expect(gasPriceCeiling(fees.current()!)).toBe(EXECUTION_POLICY.maxFeePerGas);
    expect(fees.current()).toBe(fees.current());
  } finally { fees.stop(); }
});

test('auto fees warm once, reuse the cached quote, and reject an old snapshot after refresh', async () => {
  let reads = 0;
  const fees = new GasFees(async () => ({ maxFeePerGas: BigInt(500 + ++reads), maxPriorityFeePerGas: 3n }), policy);
  try {
    await fees.start();
    const first = fees.current()!;
    expect(gasPriceCeiling(first)).toBe(501n);
    expect(fees.current()).toBe(first);
    expect(reads).toBe(1);
    await until(() => reads >= 2 && fees.current() !== first);
    expect(fees.isCurrent(first)).toBe(false);
    expect(gasPriceCeiling(fees.current()!)).toBeGreaterThan(501n);
  } finally { fees.stop(); }
});

test('auto fees pause on an estimate above the ceiling or a failed refresh, then recover', async () => {
  let reads = 0;
  const fees = new GasFees(async () => {
    reads++;
    if (reads === 1) return { maxFeePerGas: 1001n, maxPriorityFeePerGas: 3n };
    if (reads === 2) throw new Error('RPC unavailable');
    return { maxFeePerGas: 500n, maxPriorityFeePerGas: 3n };
  }, policy);
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await fees.start();
    expect(fees.current()).toBeNull();
    await until(() => reads >= 3 && fees.current() !== null);
    expect(gasPriceCeiling(fees.current()!)).toBe(500n);
    expect(warn).toHaveBeenCalledTimes(2);
  } finally { fees.stop(); warn.mockRestore(); }
});

test('auto fee snapshot expires if periodic refresh does not complete', async () => {
  const fees = new GasFees(async () => ({ maxFeePerGas: 500n, maxPriorityFeePerGas: 3n }),
    { ...policy, feeRefreshIntervalMs: 300_000 });
  try {
    await fees.start();
    const snapshot = fees.current()!;
    const now = spyOn(Date, 'now').mockReturnValue(snapshot.validUntil);
    try {
      expect(fees.current()).toBeNull();
      expect(fees.isCurrent(snapshot)).toBe(false);
    } finally { now.mockRestore(); }
  } finally { fees.stop(); }
});
