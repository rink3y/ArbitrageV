import { MarketGraph } from './market-graph';
import { type ArbitrageSearchPolicy, type MarketRoute, type MarketSizedRoute } from './types';

export function sizeRoute(
  graph: MarketGraph,
  policy: ArbitrageSearchPolicy,
  route: MarketRoute,
  cost: (amountIn: bigint) => bigint = () => 0n
): MarketSizedRoute {
  const range = completeInputRange(graph, route);
  if (!range) {
    return { profit: 0n, optimalInput: 0n, complete: false };
  }
  let { low, high } = range;

  for (let i = 0; i < policy.optimizationIterations && high - low > 3n; i++) {
    const third = (high - low) / 3n;

    const mid1 = low + third;
    const mid2 = high - third;
    const profit1 = quoteProfit(graph, route, mid1, cost);
    const profit2 = quoteProfit(graph, route, mid2, cost);

    if (profit2 === null) {
      low = mid2 + 1n;
    } else if (profit1 === null || profit1 < profit2) {
      low = mid1 + 1n;
    } else {
      high = mid2 - 1n;
    }
  }

  return bestFinalCandidate(graph, route, low, high, cost);
}

function completeInputRange(graph: MarketGraph, route: MarketRoute): { low: bigint; high: bigint } | null {
  let low = 1n;
  let high = graph.maxInputForRoute(route);
  let probe = high;

  while (low <= high) {
    const quote = graph.quote(route, probe);
    if (quote.complete) {
      return { low, high: largestCompleteInput(graph, route, probe, high) };
    }
    if (quote.belowMinimum) low = probe + 1n;
    else high = probe - 1n;
    probe = low + (high - low) / 2n;
  }

  return null;
}

function largestCompleteInput(graph: MarketGraph, route: MarketRoute, left: bigint, right: bigint): bigint {
  while (left < right) {
    const middle = (left + right + 1n) / 2n;
    if (graph.quote(route, middle).complete) left = middle;
    else right = middle - 1n;
  }
  return left;
}

function quoteProfit(graph: MarketGraph, route: MarketRoute, amountIn: bigint, cost: (amountIn: bigint) => bigint): bigint | null {
  const quote = graph.quote(route, amountIn);
  return quote.complete ? quote.profit - cost(amountIn) : null;
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
