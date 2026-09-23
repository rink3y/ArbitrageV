import { type MarketGraph } from '../market-graph/market-graph';
import { type ArbitrageOpportunity } from './opportunity-types';
import { quoteV2ExactInput } from '../protocols/v2/quote';
import { flashLoanFee } from '../execution/execution-planner';

/** Local V2-only fill model, not a transaction simulator. Null leaves the graph unchanged. */
export type V2ReplayPlan = Pick<ArbitrageOpportunity, 'path' | 'optimalInput' | 'flashPoolAddress'> & {
  split?: Pick<NonNullable<ArbitrageOpportunity['split']>, 'stages' | 'minSurplusAfterRepayment'>;
};
export function applyV2SplitFill(graph: MarketGraph, opportunity: V2ReplayPlan): bigint | null {
  if (!opportunity.split || !opportunity.flashPoolAddress) return null;
  const pairs = new Map(graph.getAllPairs().map(pair => [pair.pairAddress.toLowerCase(), { ...pair }]));
  const funding = pairs.get(opportunity.flashPoolAddress.toLowerCase());
  if (!funding || funding.variant !== 'uniswap-v2') return null;
  const touched = new Set<string>([funding.pairAddress.toLowerCase()]);
  const start = opportunity.path[0].toLowerCase();
  if (funding.token0.toLowerCase() !== start && funding.token1.toLowerCase() !== start) return null;
  if ((funding.token0.toLowerCase() === start ? funding.reserve0 : funding.reserve1) <= opportunity.optimalInput) return null;
  let available = opportunity.optimalInput;
  let token = start;
  for (const [stageIndex, stage] of opportunity.split.stages.entries()) {
    if (stage.tokenIn.toLowerCase() !== token) return null;
    let spent = 0n;
    let received = 0n;
    for (const branch of stage.branches) {
      const key = branch.pool.toLowerCase();
      const pair = pairs.get(key);
      if (branch.protocol !== 'v2' || !pair || pair.fee !== branch.fee || touched.has(key) || branch.amountIn <= 0n) return null;
      touched.add(key);
      const forward = pair.token0.toLowerCase() === token;
      if ((!forward && pair.token1.toLowerCase() !== token) ||
          (forward ? pair.token1 : pair.token0).toLowerCase() !== stage.tokenOut.toLowerCase()) return null;
      const output = quoteV2ExactInput(branch.amountIn, { variant: pair.variant, reserveIn: forward ? pair.reserve0 : pair.reserve1,
        reserveOut: forward ? pair.reserve1 : pair.reserve0, scaleIn: forward ? pair.scale0 : pair.scale1,
        scaleOut: forward ? pair.scale1 : pair.scale0, fee: pair.fee });
      if (output <= 0n || output < branch.minAmountOut) return null;
      spent += branch.amountIn; received += output;
      if (forward) { pair.reserve0 += branch.amountIn; pair.reserve1 -= output; }
      else { pair.reserve1 += branch.amountIn; pair.reserve0 -= output; }
    }
    if (spent > available || (stageIndex === 0 && spent !== available)) return null;
    available = received; token = stage.tokenOut.toLowerCase();
  }
  const fee = flashLoanFee({ protocol: 'v2', poolAddress: funding.pairAddress, fee: funding.fee, liquidity: 0n }, opportunity.optimalInput);
  const surplus = available - opportunity.optimalInput - fee;
  if (token !== start || surplus < opportunity.split.minSurplusAfterRepayment) return null;
  if (funding.token0.toLowerCase() === start) funding.reserve0 += fee;
  else funding.reserve1 += fee;
  graph.updateReserves([...touched].map(key => pairs.get(key)!));
  return surplus;
}

export const replayJSON = {
  stringify: (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? { $bigint: item.toString() } : item),
  parse: (value: string): unknown => JSON.parse(value, (_, item) => item && typeof item === 'object' &&
    Object.keys(item).length === 1 && typeof item.$bigint === 'string' && /^-?\d+$/.test(item.$bigint) ? BigInt(item.$bigint) : item),
};
