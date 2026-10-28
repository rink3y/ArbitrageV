import { describe, expect, test } from 'bun:test';
import { type Address } from 'viem';
import { MarketGraph } from '../src/market-graph/market-graph';
import { sizeRoute } from '../src/market-graph/route-sizer';
import { estimateTransfer, type TokenTransferProfile, type TransferEstimate, type TransferSample } from '../src/protocols/v2/transfer-fees';
import { type PairInfo } from '../src/protocols/v2/types';
import { ARBITRAGE_SEARCH_POLICY } from '../src/constants';

type Legs = { buy?: TransferEstimate; sell?: TransferEstimate };

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const a = addr(1), b = addr(2);
const sample = (requested: bigint, credited = requested): TransferSample => ({ requested, debited: requested, credited });
const range = (min: bigint, max: bigint) => estimateTransfer([sample(min), sample(max)]);
const wide = range(10_000n, 10n ** 12n);
function profile(token: Address, pool: Address, legs: Legs = {}): TokenTransferProfile {
  return { token, pool, executor: addr(3), origin: addr(4), recipient: addr(4), blockNumber: 1n,
    observedAt: Date.now(), validUntil: Date.now() + 3_600_000, buy: legs.buy ?? wide, sell: legs.sell ?? wide, transfer: wide };
}
function pair(pool: Address, reserve0: bigint, reserve1: bigint, token0?: Legs, token1?: Legs): PairInfo {
  return { pairAddress: pool, token0: a, token1: b, reserve0, reserve1, fee: 30, variant: 'uniswap-v2',
    scale0: 10n ** 18n, scale1: 10n ** 18n, transferProfiles: { token0: profile(a, pool, token0), token1: profile(b, pool, token1) } };
}
function sizeCycle(first: PairInfo, second: PairInfo) {
  const graph = new MarketGraph();
  graph.addPair(first); graph.addPair(second);
  const e1 = graph.splitEdgeIndexes(a, b, 10, () => true).find(e => graph.edgeAt(e)?.poolAddress === first.pairAddress)!;
  const e2 = graph.splitEdgeIndexes(b, a, 10, () => true).find(e => graph.edgeAt(e)?.poolAddress === second.pairAddress)!;
  const route = { path: [a, b, a], pools: [first.pairAddress, second.pairAddress],
    edgeIds: [graph.edgeAt(e1)!.id, graph.edgeAt(e2)!.id], edgeIndexes: [e1, e2], protocols: ['v2', 'v2'] as ('v2')[] };
  return { graph, route, sized: sizeRoute(graph, ARBITRAGE_SEARCH_POLICY, route) };
}

describe('route sizing with bounded transfer profiles', () => {
  test('finds a downstream range narrower than one halving step', () => {
    const { graph, route, sized } = sizeCycle(pair(addr(10), 100_000_000n, 200_000_000n),
      pair(addr(11), 200_000_000n, 100_000_000n, {}, { sell: range(200_000n, 280_000n) }));
    expect(graph.quote(route, 156_250n).complete).toBe(false);
    expect(graph.quote(route, 78_125n).complete).toBe(false);
    expect(sized.complete).toBe(true);
    expect(sized.profit).toBeGreaterThan(0n);
    expect(graph.quote(route, sized.optimalInput).complete).toBe(true);
    expect(graph.quote(route, sized.optimalInput + 1n).complete).toBe(false);
  });

  test('keeps a first-hop range that sits near the maximum input', () => {
    const { graph, route, sized } = sizeCycle(pair(addr(10), 100_000_000n, 200_000_000n, { sell: range(8_000_000n, 10_000_000n) }),
      pair(addr(11), 200_000_000n, 100_000_000n));
    expect(graph.quote(route, 6_000_000n).complete).toBe(false);
    expect(sized.complete).toBe(true);
    expect(sized.optimalInput).toBeGreaterThanOrEqual(8_000_000n);
    expect(sized.optimalInput).toBeLessThanOrEqual(10_000_000n);
    expect(sized.profit).toBe(graph.quote(route, sized.optimalInput).profit);
  });

  test('treats a taxed output that rounds to zero inside its range as too small', () => {
    const taxedBuy = estimateTransfer([sample(5_000n, 1n), sample(12_000n, 2n)]);
    const { graph, route, sized } = sizeCycle(pair(addr(10), 100_000_000n, 200_000_000n, { sell: range(1n, 10n ** 12n) }, { buy: taxedBuy }),
      pair(addr(11), 10n ** 15n, 1_000n, {}, { sell: range(1n, 10n ** 12n) }));
    expect(graph.quote(route, 4_883n)).toMatchObject({ complete: false, belowMinimum: true });
    expect(graph.quote(route, 9_766n)).toMatchObject({ complete: false, belowMinimum: false });
    expect(sized.complete).toBe(true);
    expect(sized.profit).toBeGreaterThan(0n);
  });

  test('treats a taxed input that rounds to zero inside its range as too small', () => {
    const taxedSell = estimateTransfer([sample(1n), sample(16_000n, 15_999n)]);
    const { graph, route, sized } = sizeCycle(pair(addr(10), 1_000n, 1_000_000_000n, { sell: taxedSell }, { buy: range(10_000n, 1_500_000n) }),
      pair(addr(11), 1_000_000_000n, 1_000_000_000n));
    expect(graph.quote(route, 1n)).toMatchObject({ complete: false, belowMinimum: true });
    expect(graph.quote(route, 3n)).toMatchObject({ complete: false, belowMinimum: false });
    expect(sized).toMatchObject({ complete: true, optimalInput: 2n });
  });

  test('reports no size when the route has no complete input', () => {
    const { sized } = sizeCycle(pair(addr(10), 100_000_000n, 200_000_000n, { sell: range(10_000n, 20_000n) }),
      pair(addr(11), 200_000_000n, 100_000_000n, {}, { sell: range(10n ** 9n, 10n ** 10n) }));
    expect(sized).toEqual({ profit: 0n, optimalInput: 0n, complete: false });
  });
});
