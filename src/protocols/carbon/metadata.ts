import { logger } from '../../reporting/logger';
import { parseAbi, type Address } from 'viem';
import { CONFIGURED_TOKENS } from '../../constants';
import { graphToken } from '../../tokens';
import { CARBON_CONTROLLERS } from './config';
import { type CarbonPairMetadata } from './types';

type CarbonClient = { readContract(parameters: any): Promise<unknown> };

export type DiscoverCarbonPairsOptions = {
  allowedTokens?: readonly Address[];
};

const CONTROLLER_ABI = parseAbi([
  'function pairs() view returns (address[2][])',
  'function pairTradingFeePPM(address token0, address token1) view returns (uint32)',
  'function strategiesByPairCount(address token0, address token1) view returns (uint256)',
]);

export async function discoverCarbonPairs(
  client: CarbonClient,
  options: DiscoverCarbonPairsOptions = {}
): Promise<CarbonPairMetadata[]> {
  const allowed = new Set([
    ...CONFIGURED_TOKENS.map(token => graphToken(token.address).toLowerCase()),
    ...(options.allowedTokens ?? []).map(token => graphToken(token).toLowerCase()),
  ]);
  const pairs: CarbonPairMetadata[] = [];
  for (const controller of CARBON_CONTROLLERS) {
    if (!controller.enabled) continue;
    const rawPairs = await client.readContract({
      address: controller.address,
      abi: CONTROLLER_ABI,
      functionName: 'pairs',
    }) as readonly [Address, Address][];
    for (const [token0, token1] of rawPairs) {
      if (!allowed.has(graphToken(token0).toLowerCase()) || !allowed.has(graphToken(token1).toLowerCase())) continue;
      const strategyCount = await client.readContract({
        address: controller.address,
        abi: CONTROLLER_ABI,
        functionName: 'strategiesByPairCount',
        args: [token0, token1],
      }) as bigint;
      if (strategyCount === 0n) continue;
      const feePpm = await client.readContract({
        address: controller.address,
        abi: CONTROLLER_ABI,
        functionName: 'pairTradingFeePPM',
        args: [token0, token1],
      }) as number;
      pairs.push({ controller: controller.address, token0, token1, strategyCount: Number(strategyCount), feePpm: Number(feePpm) });
    }
    if (logger.debugEnabled) logger.debug(`Carbon ${controller.name}: kept ${pairs.length} discovered pairs`);
  }
  return pairs;
}
