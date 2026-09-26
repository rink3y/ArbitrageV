import { decodeAbiParameters, type Address } from 'viem';
import { type MarketGraph } from '../market-graph/market-graph';
import { type GraphChanges } from '../market-graph/changes';
import { type ArbitrageOpportunity } from './opportunity-types';
import { quoteV2ExactInput } from '../protocols/v2/quote';
import { quoteV3MultiRangeExactInput } from '../protocols/v3/quote';
import { quoteCarbonExactInputBeforeFee } from '../protocols/carbon/quote';
import { receivedAfterTransfer } from '../protocols/v2/transfer-fees';
import { flashLoanFee } from '../execution/execution-planner';
import { canSettle, graphToken } from '../tokens';

// Copy only changed pool/strategy records. The observed graph is never advanced
// because a transaction was submitted. Its owner applies these changes inside
// withProjectedChanges and restores it before processing the next event.
export function projectOpportunity(graph: MarketGraph, opportunity: ArbitrageOpportunity): GraphChanges | null {
  const changes: GraphChanges = { pairs: [], removedPairs: [], v3: [], removedV3: [], versions: {} };
  const strategies = new Map<string, NonNullable<ReturnType<MarketGraph['getCarbonStrategy']>>>();
  const used = new Set<string>();
  const swap = (pool: Address, protocol: string, token: Address, amount: bigint, data: `0x${string}`): { token: Address; amount: bigint } | null => {
    if (amount <= 0n) return null;
    if (protocol !== 'carbon' && used.has(pool.toLowerCase())) return null;
    used.add(pool.toLowerCase());
    if (protocol === 'v2') {
      const original = graph.getPair(pool);
      if (!original) return null;
      const forward = original.token0.toLowerCase() === token.toLowerCase();
      if (!forward && original.token1.toLowerCase() !== token.toLowerCase()) return null;
      const input = forward ? original.transferProfiles?.token0 : original.transferProfiles?.token1;
      const output = forward ? original.transferProfiles?.token1 : original.transferProfiles?.token0;
      // Probes measure credits, not arbitrary autoswaps/rebases. Taxed routes
      // remain executable, but do not seed speculative successors.
      if (input && (input.sell.feeBps !== 0 || input.buy.feeBps !== 0) ||
          output && (output.sell.feeBps !== 0 || output.buy.feeBps !== 0)) return null;
      const credit = input ? receivedAfterTransfer(amount, input.sell, input.validUntil) : amount;
      const nominal = quoteV2ExactInput(credit, { variant: original.variant, fee: original.fee,
        reserveIn: forward ? original.reserve0 : original.reserve1, reserveOut: forward ? original.reserve1 : original.reserve0,
        scaleIn: forward ? original.scale0 : original.scale1, scaleOut: forward ? original.scale1 : original.scale0 });
      const received = output ? receivedAfterTransfer(nominal, output.buy, output.validUntil) : nominal;
      if (credit <= 0n || received <= 0n) return null;
      // Solidly pays swap fees out of the pair before publishing its reserves.
      const reserveCredit = original.variant === 'uniswap-v2' ? credit : credit - credit * BigInt(original.fee) / 10000n;
      changes.pairs.push({ ...original,
        reserve0: original.reserve0 + (forward ? reserveCredit : -nominal),
        reserve1: original.reserve1 + (forward ? -nominal : reserveCredit) });
      return { token: forward ? original.token1 : original.token0, amount: received };
    }
    if (protocol === 'v3') {
      const info = graph.getV3Pool(pool);
      if (!info?.state || !info.fullRange) return null;
      const forward = info.token0.toLowerCase() === token.toLowerCase();
      if (!forward && info.token1.toLowerCase() !== token.toLowerCase()) return null;
      const quote = quoteV3MultiRangeExactInput({ ...info.state, amountIn: amount, fee: info.fee,
        direction: forward ? 'token0ToToken1' : 'token1ToToken0', fullRange: true,
        ticks: graph.getV3InitializedTicks(pool), normalizedTicks: true });
      if (quote.exhaustedLiquidity || quote.amountOut <= 0n) return null;
      changes.v3.push({ pool: info, fullRange: true, replaceTicks: false, ticks: [],
        state: { sqrtPriceX96: quote.sqrtPriceX96After, liquidity: quote.liquidityAfter, tick: quote.tickAfter } });
      return { token: forward ? info.token1 : info.token0, amount: quote.amountOut };
    }
    if (protocol !== 'carbon') return null;
    let source: Address, target: Address, ids: readonly bigint[], amounts: readonly bigint[];
    if (data.length === 194) {
      const [id, from, to] = decodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'address' }], data);
      source = from; target = to; ids = [id]; amounts = [amount];
    } else {
      [source, target, ids, amounts] = decodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }, { type: 'uint256[]' }, { type: 'uint128[]' }], data);
    }
    if (graphToken(source).toLowerCase() !== token.toLowerCase() || ids.length !== amounts.length ||
        amounts.reduce((sum, value) => sum + value, 0n) !== amount) return null;
    let total = 0n;
    let fee: number | undefined;
    for (let i = 0; i < ids.length; i++) {
      const key = pool.toLowerCase() + ':' + ids[i];
      const original = graph.getCarbonStrategy(pool, ids[i]);
      if (!original || strategies.has(key)) return null;
      const index = original.token0.toLowerCase() === target.toLowerCase() ? 0 : 1;
      if ((index === 0 ? original.token1 : original.token0).toLowerCase() !== source.toLowerCase() ||
          (index === 0 ? original.token0 : original.token1).toLowerCase() !== target.toLowerCase()) return null;
      if (fee !== undefined && fee !== original.feePpm) return null;
      fee = original.feePpm;
      const quote = quoteCarbonExactInputBeforeFee(amounts[i], original.orders[index]);
      if (!quote.complete) return null;
      const next = { ...original, orders: original.orders.map(order => ({ ...order })) as typeof original.orders };
      next.orders[index].y -= quote.amountOut;
      const other = next.orders[1 - index];
      other.y += amounts[i];
      if (other.y >= 1n << 128n) return null;
      if (other.z < other.y) other.z = other.y;
      strategies.set(key, next);
      total += quote.amountOut;
    }
    return { token: graphToken(target), amount: total * BigInt(1_000_000 - (fee ?? 0)) / 1_000_000n };
  };
  try {
    let current = { token: opportunity.path[0], amount: opportunity.optimalInput };
    if (opportunity.split) {
      for (const stage of opportunity.split.stages) {
        if (stage.tokenIn.toLowerCase() !== current.token.toLowerCase()) return null;
        let spent = 0n, received = 0n;
        for (const branch of stage.branches) {
          const out = swap(branch.pool, branch.protocol, stage.tokenIn, branch.amountIn, branch.data);
          if (!out || out.token.toLowerCase() !== stage.tokenOut.toLowerCase() || out.amount < branch.minAmountOut) return null;
          spent += branch.amountIn; received += out.amount;
        }
        if (spent > current.amount) return null;
        current = { token: stage.tokenOut, amount: received };
      }
    } else {
      for (let i = 0; i < opportunity.pairs.length; i++) {
        const out = swap(opportunity.pairs[i], opportunity.protocols[i], current.token, current.amount, opportunity.routeData[i]);
        if (!out) return null;
        current = out;
      }
    }
    if (!canSettle(current.token, opportunity.path[0])) return null;
    if (!opportunity.routeSwap && !opportunity.v2RouteFlash) {
      const lender = graph.findBestFlashPoolForToken(opportunity.path[0], opportunity.optimalInput, opportunity.pairs);
      if (!lender || lender.poolAddress.toLowerCase() !== opportunity.flashPoolAddress?.toLowerCase()) return null;
      const fee = flashLoanFee(lender, opportunity.optimalInput);
      if (current.amount <= opportunity.optimalInput + fee) return null;
      if (lender.protocol === 'v2') {
        const pair = graph.getPair(lender.poolAddress)!;
        const forward = pair.token0.toLowerCase() === opportunity.path[0].toLowerCase();
        changes.pairs.push({ ...pair, reserve0: pair.reserve0 + (forward ? fee : 0n), reserve1: pair.reserve1 + (forward ? 0n : fee) });
      }
      // V3 flash fees accrue outside the price/tick/liquidity state used to quote.
    } else if (current.amount <= opportunity.optimalInput) return null;
    if (strategies.size) changes.carbon = { kind: 'delta', upserts: [...strategies.values()], removed: [] };
    changes.versions = graph.marketVersions([...opportunity.pairs, ...(opportunity.flashPoolAddress ? [opportunity.flashPoolAddress] : [])], !!changes.carbon);
    return changes;
  } catch { return null; }
}
