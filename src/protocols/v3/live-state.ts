import { type MarketGraph } from '../../market-graph/market-graph';
import { type DecodedV3PoolEvent } from './events';
import { MAX_TICK, MIN_TICK, getSqrtRatioAtTick } from './quote';
import { type V3PoolInfo, type V3Tick } from './types';

const MAX_LIQUIDITY = (1n << 128n) - 1n;

export function applyV3Event(graph: MarketGraph, pool: V3PoolInfo, event: DecodedV3PoolEvent): void {
  if (!pool.fullRange || !pool.state) throw new Error('V3 pool is not ready');
  if (event.kind === 'collect') return;
  if (event.kind === 'liquidity') {
    const { tickLower, tickUpper, amount, kind } = event.update;
    if (tickLower < MIN_TICK || tickUpper > MAX_TICK || tickLower >= tickUpper ||
      tickLower % pool.tickSpacing !== 0 || tickUpper % pool.tickSpacing !== 0) throw new Error('Invalid liquidity range');
    const delta = kind === 'mint' ? amount : -amount;
    const ticks: V3Tick[] = [[tickLower, 1n], [tickUpper, -1n]].map(([rawIndex, sign]) => {
      const index = Number(rawIndex);
      const old = pool.ticks.get(index);
      const liquidityGross = (old?.liquidityGross ?? 0n) + delta;
      const liquidityNet = (old?.liquidityNet ?? 0n) + delta * BigInt(sign);
      if (liquidityGross < 0n || liquidityGross > MAX_LIQUIDITY || abs(liquidityNet) > liquidityGross) throw new Error('Inconsistent tick liquidity');
      return { index, liquidityGross, liquidityNet };
    });
    const liquidity = pool.state.liquidity + (pool.state.tick >= tickLower && pool.state.tick < tickUpper ? delta : 0n);
    if (liquidity < 0n || liquidity > MAX_LIQUIDITY) throw new Error('Invalid active liquidity');
    // Validate both boundaries before mutating either of them.
    graph.updateV3Ticks([{ poolAddress: pool.address, ticks }]);
    graph.updateV3PoolStates([{ poolAddress: pool.address, ...pool.state, liquidity }]);
    return;
  }
  const update = event.update;
  if (update.tick < MIN_TICK || update.tick >= MAX_TICK || update.sqrtPriceX96 <= 0n || update.liquidity > MAX_LIQUIDITY) throw new Error('Invalid V3 state');
  // At a leftward crossing slot0.tick can be one below the exact price tick.
  if (update.sqrtPriceX96 < getSqrtRatioAtTick(update.tick) || update.sqrtPriceX96 > getSqrtRatioAtTick(update.tick + 1)) throw new Error('V3 price and tick disagree');
  if (event.kind === 'initialize') {
    if (pool.state.sqrtPriceX96 !== 0n || pool.ticks.size > 0) throw new Error('Repeated V3 initialization');
  } else {
    const ticks = graph.getV3InitializedTicks(pool.address);
    const low = Math.min(pool.state.tick, update.tick);
    const high = Math.max(pool.state.tick, update.tick);
    let left = 0;
    let right = ticks.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (ticks[middle].index <= low) left = middle + 1;
      else right = middle;
    }
    let liquidity = pool.state.liquidity;
    for (let i = left; i < ticks.length && ticks[i].index <= high; i++) {
      liquidity += pool.state.tick < update.tick ? ticks[i].liquidityNet : -ticks[i].liquidityNet;
    }
    if (liquidity !== update.liquidity) throw new Error('Swap liquidity disagrees with local ticks');
  }
  graph.updateV3PoolStates([{ poolAddress: pool.address, ...update }]);
}

function abs(value: bigint) { return value < 0n ? -value : value; }
