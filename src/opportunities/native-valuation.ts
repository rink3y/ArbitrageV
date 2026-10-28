import { type Address } from 'viem';
import { type MarketGraph } from '../market-graph/market-graph';
import { isNativeWrapper } from '../tokens';

export type NativeValue = { amount: bigint; pools: Address[]; carbon: boolean };

// Value the actual surplus, including swap fees, profile deductions and price
// impact. These are local quotes, not a frozen reserve ratio or an oracle.
export function nativeValue(graph: MarketGraph, token: Address, amount: bigint, excluded: readonly Address[] = []): NativeValue | null {
  if (amount <= 0n) return null;
  if (isNativeWrapper(token)) return { amount, pools: [], carbon: false };
  const blocked = new Set(excluded.map(pool => pool.toLowerCase()));
  const walk = (from: Address, input: bigint, remaining: number, pools: Address[], carbon: boolean): NativeValue | null => {
    const index = graph.tokenIndexOf(from);
    if (index === undefined) return null;
    let best: NativeValue | null = null;
    for (const edgeIndex of graph.rankedEdgeIndexes(index, 8)) {
      const edge = graph.edgeAt(edgeIndex);
      if (!edge || blocked.has(edge.poolAddress.toLowerCase()) || pools.some(pool => pool.toLowerCase() === edge.poolAddress.toLowerCase())) continue;
      let quote;
      try { quote = graph.quoteEdgeAt(edgeIndex, input); } catch { continue; }
      if (!quote.complete || quote.amountOut <= 0n) continue;
      const nextPools = [...pools, edge.poolAddress];
      const hasCarbon = carbon || edge.protocol === 'carbon';
      const value = isNativeWrapper(edge.to) ? { amount: quote.amountOut, pools: nextPools, carbon: hasCarbon }
        : remaining > 1 ? walk(edge.to, quote.amountOut, remaining - 1, nextPools, hasCarbon) : null;
      if (value && (!best || value.amount > best.amount)) best = value;
    }
    return best;
  };
  const value = walk(token, amount, 2, [], false);
  // Small valuation haircut, separate from transaction gas and native profit floor.
  return value && { ...value, amount: value.amount * 9950n / 10000n };
}
