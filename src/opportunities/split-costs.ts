import { NETWORK, type TokenConfig } from '../constants';
import { gasPriceCeiling, type GasFeeSnapshot } from '../execution/gas-fees';
import { type SplitCosts } from './split-routing';

export function splitCostsFromSnapshot(tokens: readonly TokenConfig[], fees: GasFeeSnapshot, now = Date.now()): SplitCosts {
  const wrappedNative = NETWORK.wrappedNativeToken.toLowerCase();
  const rates: SplitCosts['rates'] = { [wrappedNative]: { numerator: 1n, denominator: 1n } };
  let validUntil = Math.min(now + 30_000, fees.validUntil);
  for (const token of tokens) {
    const rate = token.gasConversion;
    if (!rate) continue;
    if (token.address.toLowerCase() === wrappedNative || !Number.isFinite(rate.validUntil) ||
        rate.validUntil <= now || rate.numerator <= 0n || rate.denominator <= 0n) continue;
    rates[token.address.toLowerCase()] = rate;
    validUntil = Math.min(validUntil, rate.validUntil);
  }
  return { rates, validUntil, gasPriceWei: gasPriceCeiling(fees) };
}
