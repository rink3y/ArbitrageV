import { type Address } from 'viem';

export type CarbonControllerConfig = {
  name: string;
  address: Address;
  enabled: boolean;
};

export const CARBON_STARTUP_POLICY = {
  batchSize: 20,
} as const;

export const CARBON_CONTROLLERS: readonly CarbonControllerConfig[] = [
  { name: 'carbon', address: '0xe4816658ad10bf215053c533cceae3f59e1f1087', enabled: true },
];
