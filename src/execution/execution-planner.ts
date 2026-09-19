import { type Address } from 'viem';
import { type FlashPoolCandidate } from '../market-graph/types';
import { type ArbitrageOpportunity } from '../opportunities/opportunity-types';
import { protocolPlugin } from '../protocols/registry';

export type ExecutableOpportunity = Pick<
  ArbitrageOpportunity,
  'path' | 'pairs' | 'protocols' | 'fees' | 'routeData' | 'optimalInput' | 'profit' | 'marketVersions' | 'observedAt' | 'flashPoolAddress'
>;

export type FlashPoolLookup = {
  matchesVersions?(versions: NonNullable<ArbitrageOpportunity['marketVersions']>): boolean;
  findBestFlashPoolForToken(
    token: Address,
    amountIn: bigint,
    excludePools?: Address[]
  ): FlashPoolCandidate | null;
};

export type ArbContractParams = {
  flashProtocol: number;
  flashPool: Address;
  borrowToken: Address;
  borrowAmount: bigint;
  v2RepayFee: bigint;
  pools: Address[];
  protocols: number[];
  fees: bigint[];
  data: `0x${string}`[];
};

export type ExecutionPlan = {
  kind: 'flash';
  params: ArbContractParams;
};

export function flashLoanFee(pool: FlashPoolCandidate, amount: bigint): bigint {
  return protocolPlugin(pool.protocol).flashLoanFee?.(pool.fee, amount) ?? 0n;
}

export function createExecutionPlan(graph: FlashPoolLookup, opportunity: ExecutableOpportunity): ExecutionPlan | null {
  if (!isCircular(opportunity.path)) return null;
  if (opportunity.pairs.length !== opportunity.protocols.length) return null;
  if (opportunity.pairs.length !== opportunity.fees.length) return null;
  if (opportunity.pairs.length !== opportunity.routeData.length) return null;

  const borrowToken = opportunity.path[0];
  const flashPool = graph.findBestFlashPoolForToken(
    borrowToken,
    opportunity.optimalInput,
    opportunity.pairs
  );

  if (!flashPool) return null;
  if (opportunity.flashPoolAddress && flashPool.poolAddress.toLowerCase() !== opportunity.flashPoolAddress.toLowerCase()) return null;
  const flashPlugin = protocolPlugin(flashPool.protocol);
  if (!flashPlugin.flashLoanFee) return null;

  return {
    kind: 'flash',
    params: {
      flashProtocol: flashPlugin.contractId,
      flashPool: flashPool.poolAddress,
      borrowToken,
      borrowAmount: opportunity.optimalInput,
      v2RepayFee: flashPlugin.flashRepayFee?.(flashPool.fee) ?? 0n,
      pools: opportunity.pairs,
      protocols: opportunity.protocols.map(protocol => protocolPlugin(protocol).contractId),
      fees: opportunity.fees.map(fee => BigInt(fee)),
      data: opportunity.routeData,
    },
  };
}

function isCircular(path: Address[]): boolean {
  if (path.length < 2) return false;
  return path[0].toLowerCase() === path[path.length - 1].toLowerCase();
}
