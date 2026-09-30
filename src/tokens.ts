import { type Address } from 'viem';
import { WRAPPED_NATIVE_TOKENS } from './constants';

export function isNativeWrapper(token: string): boolean {
  return WRAPPED_NATIVE_TOKENS.some(wrapper => wrapper.address.toLowerCase() === token.toLowerCase());
}

export function canSettle(from: string, to: string): boolean {
  return from.toLowerCase() === to.toLowerCase() || (isNativeWrapper(from) && isNativeWrapper(to));
}

// Carbon's native-token sentinel, independent of the selected chain.
export const NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as Address;

export function graphToken(token: Address): Address {
  return token.toLowerCase() === NATIVE_TOKEN.toLowerCase() ? WRAPPED_NATIVE_TOKENS[0].address : token;
}
