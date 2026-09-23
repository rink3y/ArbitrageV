import { EXECUTION_POLICY, NETWORK, TOKENS, type TokenConfig } from '../constants';
import { type SplitCosts } from './split-routing';

export function splitCostsFromConstants(tokens: readonly TokenConfig[] = TOKENS, now = Date.now()): SplitCosts {
  const wrappedNative = NETWORK.wrappedNativeToken.toLowerCase();
  const rates: SplitCosts['rates'] = { [wrappedNative]: { numerator: 1n, denominator: 1n } };
  let validUntil = now + 30_000;
  for (const token of tokens) {
    const rate = token.gasConversion;
    if (!rate) continue;
    if (token.address.toLowerCase() === wrappedNative || !Number.isFinite(rate.validUntil) ||
        rate.validUntil <= now || rate.numerator <= 0n || rate.denominator <= 0n) continue;
    rates[token.address.toLowerCase()] = rate;
    validUntil = Math.min(validUntil, rate.validUntil);
  }
  return { rates, validUntil, gasPriceWei: EXECUTION_POLICY.legacy ? EXECUTION_POLICY.legacyGasPrice : EXECUTION_POLICY.maxFeePerGas };
}
