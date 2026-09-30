import { WRAPPED_NATIVE_TOKENS } from '../constants';
import { gasPriceCeiling, type GasFeeSnapshot } from '../execution/gas-fees';
import { type SplitCosts } from './split-routing';

export function splitCostsFromSnapshot(fees: GasFeeSnapshot, now = Date.now()): SplitCosts {
  const rates: SplitCosts['rates'] = {};
  for (const { address } of WRAPPED_NATIVE_TOKENS) rates[address.toLowerCase()] = { numerator: 1n, denominator: 1n };
  const validUntil = Math.min(now + 30_000, fees.validUntil);
  return { rates, validUntil, gasPriceWei: gasPriceCeiling(fees) };
}
