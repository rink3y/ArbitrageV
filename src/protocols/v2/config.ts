import { type Address } from 'viem';
import { tokenAmount } from '../../values';

export type DexFactoryConfig = {
  name: string;
  address: Address;
  fee: number;
  kind: 'uniswap-v2' | 'solidly';
};

export const V2_DISCOVERY_POLICY = {
  batchSize: 200,
  solidlyReserveBatchSize: 5,
  maxPairAgeSeconds: 700 * 24 * 60 * 60,
  minOtherTokenLiquidity: tokenAmount('500'),
} as const;

export const V2_LIVE_POLICY = {
  recoveryLogsPerPool: 2_048,
} as const;

export const V2_FACTORIES: readonly DexFactoryConfig[] = [
  { name: 'dragonV1', address: '0x71f6b49ae1558357bBb5A6074f1143c46cBcA03d', fee: 30, kind: 'uniswap-v2' },
  { name: 'yakafinance', address: '0xd45dAff288075952822d5323F1d571e73435E929', fee: 18, kind: 'solidly' },
];
