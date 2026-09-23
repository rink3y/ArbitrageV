import { type Address } from 'viem';
import { NETWORK } from './constants';

// Carbon's native-token sentinel, independent of the selected chain.
export const NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as Address;

export function graphToken(token: Address): Address {
  return token.toLowerCase() === NATIVE_TOKEN.toLowerCase() ? NETWORK.wrappedNativeToken : token;
}
