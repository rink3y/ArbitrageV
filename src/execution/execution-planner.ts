import { type Address } from 'viem';
import { type FlashPoolCandidate } from '../market-graph/types';
import { type ArbitrageOpportunity } from '../opportunities/opportunity-types';
import { protocolPlugin } from '../protocols/registry';
import { EXECUTION_POLICY } from '../constants';
import { canSettle } from '../tokens';

export type ExecutableOpportunity = Pick<
  ArbitrageOpportunity,
  'path' | 'pairs' | 'protocols' | 'fees' | 'routeData' | 'optimalInput' | 'profit' | 'marketVersions' | 'observedAt' | 'flashPoolAddress' | 'v2RouteFlash' | 'split' | 'netProfit' | 'routeSwap' | 'netProfitNative' | 'followUp' | 'followUpPlan'
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

export type SplitContractParams = Pick<ArbContractParams, 'flashProtocol' | 'flashPool' | 'borrowToken' | 'borrowAmount' | 'v2RepayFee'> & {
  stages: Array<{ tokenIn: Address; tokenOut: Address; branches: Array<{
    pool: Address; protocol: number; fee: bigint; amountIn: bigint; minAmountOut: bigint; data: `0x${string}`;
  }> }>;
  deadline: bigint;
};
export type ExecutionPlan = {
  kind: 'flash';
  params: ArbContractParams;
} | {
  kind: 'v2-route-flash';
  params: { startToken: Address; amountIn: bigint; pools: Address[]; fees: bigint[] };
} | { kind: 'split'; params: SplitContractParams }
  | { kind: 'plan'; params: ContractPlan };

export type ContractPlan = { route: ArbContractParams; stages: SplitContractParams['stages']; deadline: bigint; routeSwap: boolean };

export function contractPlan(plan: ExecutionPlan): ContractPlan {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30);
  if (plan.kind === 'plan') return plan.params;
  if (plan.kind === 'v2-route-flash') return { deadline, stages: [], routeSwap: true, route: {
    flashProtocol: 0, flashPool: plan.params.pools[0], borrowToken: plan.params.startToken, borrowAmount: plan.params.amountIn,
    v2RepayFee: 0n, pools: plan.params.pools, protocols: plan.params.pools.map(() => 0), fees: plan.params.fees,
    data: plan.params.pools.map(() => '0x02'),
  } };
  if (plan.kind === 'split') return { deadline: plan.params.deadline, stages: plan.params.stages, routeSwap: false,
    route: { ...plan.params, pools: [], protocols: [], fees: [], data: [] } };
  return { deadline, stages: [], routeSwap: false, route: plan.params };
}

export function flashLoanFee(pool: FlashPoolCandidate, amount: bigint): bigint {
  return protocolPlugin(pool.protocol).flashLoanFee?.(pool.fee, amount) ?? 0n;
}

export function gasLimitForTransaction(kind: 'single' | 'batch' = 'single'): bigint {
  const limit = EXECUTION_POLICY.gasLimits[kind];
  if (limit <= 0n) throw new Error('Gas limit must be positive');
  return limit;
}

export function createExecutionPlan(graph: FlashPoolLookup, opportunity: ExecutableOpportunity): ExecutionPlan | null {
  if (!isCircular(opportunity.path)) return null;
  if (opportunity.pairs.length !== opportunity.protocols.length) return null;
  if (opportunity.pairs.length !== opportunity.fees.length) return null;
  if (opportunity.pairs.length !== opportunity.routeData.length) return null;

  if (opportunity.routeSwap) {
    if (opportunity.split || opportunity.optimalInput <= 0n || !opportunity.pairs.length ||
        !['v2', 'v3'].includes(opportunity.protocols[0]) ||
        opportunity.flashPoolAddress?.toLowerCase() !== opportunity.pairs[0].toLowerCase() ||
        new Set(opportunity.pairs.map(pool => pool.toLowerCase())).size !== opportunity.pairs.length) return null;
    return { kind: 'plan', params: { routeSwap: true, stages: [], deadline: BigInt(Math.floor(Date.now() / 1000) + 30),
      route: { flashProtocol: 0, flashPool: opportunity.pairs[0], borrowToken: opportunity.path[0], borrowAmount: opportunity.optimalInput,
        v2RepayFee: 0n, pools: opportunity.pairs, protocols: opportunity.protocols.map(protocol => protocolPlugin(protocol).contractId),
        fees: opportunity.fees.map(BigInt), data: opportunity.routeData } } };
  }

  if (opportunity.v2RouteFlash) {
    if (opportunity.split || opportunity.optimalInput <= 0n || opportunity.pairs.length < 2 ||
        opportunity.flashPoolAddress?.toLowerCase() !== opportunity.pairs[0].toLowerCase() ||
        new Set(opportunity.pairs.map(pool => pool.toLowerCase())).size !== opportunity.pairs.length ||
        opportunity.protocols.some(protocol => protocol !== 'v2') ||
        opportunity.routeData.some(data => data !== '0x02')) return null;
    return { kind: 'v2-route-flash', params: {
      startToken: opportunity.path[0], amountIn: opportunity.optimalInput,
      pools: opportunity.pairs, fees: opportunity.fees.map(BigInt),
    } };
  }

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

  if (opportunity.split) {
    const split = opportunity.split;
    if (split.stages.length < 2 || split.stages.length > 3 || split.deadline < BigInt(Math.floor(Date.now() / 1000)) ||
        split.costsValidUntil <= Date.now() || opportunity.optimalInput <= 0n) return null;
    let token = borrowToken.toLowerCase();
    let available = opportunity.optimalInput;
    let index = 0;
    for (const [stageIndex, stage] of split.stages.entries()) {
      if (stage.tokenIn.toLowerCase() !== token || stage.tokenOut.toLowerCase() === token || stage.branches.length < 1 || stage.branches.length > 2) return null;
      let spent = 0n;
      for (const branch of stage.branches) {
        if (branch.amountIn <= 0n || branch.minAmountOut <= 0n || branch.pool.toLowerCase() === flashPool.poolAddress.toLowerCase() ||
            branch.pool.toLowerCase() !== opportunity.pairs[index]?.toLowerCase() || branch.protocol !== opportunity.protocols[index] ||
            branch.fee !== opportunity.fees[index] || branch.data !== opportunity.routeData[index]) return null;
        spent += branch.amountIn;
        index++;
      }
      if (spent > available || (stageIndex === 0 && spent !== available)) return null;
      available = stage.branches.reduce((sum, branch) => sum + branch.minAmountOut, 0n);
      token = stage.tokenOut.toLowerCase();
    }
    if (!canSettle(token, borrowToken) || index !== opportunity.pairs.length || index > 6 ||
        available <= opportunity.optimalInput + flashLoanFee(flashPool, opportunity.optimalInput)) return null;
    return { kind: 'split', params: {
      flashProtocol: flashPlugin.contractId, flashPool: flashPool.poolAddress, borrowToken, borrowAmount: opportunity.optimalInput,
      v2RepayFee: flashPlugin.flashRepayFee?.(flashPool.fee) ?? 0n,
      stages: split.stages.map(stage => ({ ...stage, branches: stage.branches.map(branch => ({ ...branch,
        protocol: protocolPlugin(branch.protocol).contractId, fee: BigInt(branch.fee) })) })),
      deadline: split.deadline,
    } };
  }

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
  return canSettle(path[0], path[path.length - 1]);
}
