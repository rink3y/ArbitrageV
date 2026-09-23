import { MarketGraph } from './market-graph';
import { type ArbitrageSearchPolicy, type MarketRoute, type MarketSizedRoute } from './types';

export function sizeRoute(
  graph: MarketGraph,
  policy: ArbitrageSearchPolicy,
  route: MarketRoute,
  cost: (amountIn: bigint) => bigint = () => 0n
): MarketSizedRoute {
  let low = 1n;
  let high = graph.maxInputForRoute(route);
  let incompleteHigh = 0n;

  while (high > low && !graph.quote(route, high).complete) {
    incompleteHigh = high;
    high /= 2n;
  }

  if (high <= low) {
    return { profit: 0n, optimalInput: 0n, complete: false };
  }

  if (incompleteHigh > high) {
    let left = high;
    let right = incompleteHigh - 1n;
    while (left < right) {
      const middle = (left + right + 1n) / 2n;
      if (graph.quote(route, middle).complete) left = middle;
      else right = middle - 1n;
    }
    high = left;
  }

  for (let i = 0; i < policy.optimizationIterations && high - low > 3n; i++) {
    const third = (high - low) / 3n;

    const mid1 = low + third;
    const mid2 = high - third;
    const profit1 = quoteProfit(graph, route, mid1, cost);
    const profit2 = quoteProfit(graph, route, mid2, cost);

    if (profit1 < profit2) {
      low = mid1 + 1n;
    } else {
      high = mid2 - 1n;
    }
  }

  return bestFinalCandidate(graph, route, low, high, cost);
}

function quoteProfit(graph: MarketGraph, route: MarketRoute, amountIn: bigint, cost: (amountIn: bigint) => bigint): bigint {
  const quote = graph.quote(route, amountIn);
  return quote.complete ? quote.profit - cost(amountIn) : -1n;
}

function bestFinalCandidate(
  graph: MarketGraph,
  route: MarketRoute,
  low: bigint,
  high: bigint,
  cost: (amountIn: bigint) => bigint
): MarketSizedRoute {
  const center = (low + high) / 2n;
  const candidates = [low, center, high, center - 2n, center - 1n, center + 1n, center + 2n];

  let profit = 0n;
  let optimalInput = 0n;
  let complete = false;

  for (const input of candidates) {
    if (input < low || input > high) continue;
    const quote = graph.quote(route, input);
    const netProfit = quote.profit - cost(input);
    if (quote.complete && netProfit > profit) {
      profit = netProfit;
      optimalInput = input;
      complete = true;
    }
  }

  return { profit, optimalInput, complete };
}
