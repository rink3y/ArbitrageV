import { type CarbonOrder } from './types';
import { compareFractions } from '../../fractions';
import { type CarbonGroupedMarketEdge, type MarketRouteQuote } from '../../market-graph/types';

export type CarbonQuote = {
  amountIn: bigint;
  amountOut: bigint;
  complete: boolean;
};

const PPM = 1_000_000n;
const ONE = 1n << 48n;
const RATE_MANTISSA_MASK = (1n << 48n) - 1n;

export type CarbonAllocation = {
  strategyId: bigint;
  amountIn: bigint;
};

export class CarbonGroupQuoter {
  private readonly allocated: bigint[] = [];
  private readonly capacities: bigint[] = [];

  quote(
    edge: CarbonGroupedMarketEdge,
    amountIn: bigint,
    allocations?: CarbonAllocation[]
  ): MarketRouteQuote {
    let remaining = amountIn;
    let amountOutBeforeFee = 0n;
    this.allocated.length = edge.orders.length;
    this.capacities.length = edge.orders.length;
    for (let index = 0; index < edge.orders.length; index++) {
      this.allocated[index] = 0n;
      this.capacities[index] = carbonSourceAmountForFullOrder(edge.orders[index].order);
    }
    const chunk = (amountIn + 15n) / 16n;

    for (let step = 0; remaining > 0n && step < 16 + edge.orders.length; step++) {
      let best = -1;
      for (let index = 0; index < edge.orders.length; index++) {
        if (this.allocated[index] >= this.capacities[index]) continue;
        if (best < 0) {
          best = index;
          continue;
        }
        const rate = carbonMarginalRateAtSource(edge.orders[index].order, this.allocated[index]);
        const bestRate = carbonMarginalRateAtSource(edge.orders[best].order, this.allocated[best]);
        if (compareFractions(rate.numerator, rate.denominator, bestRate.numerator, bestRate.denominator) > 0) best = index;
      }
      if (best < 0) break;

      const available = this.capacities[best] - this.allocated[best];
      let input = remaining < chunk ? remaining : chunk;
      if (available < input) input = available;
      if (input <= 0n) break;
      this.allocated[best] += input;
      remaining -= input;
    }

    for (let index = 0; index < edge.orders.length; index++) {
      const input = this.allocated[index];
      if (input <= 0n) continue;
      const orderQuote = quoteCarbonExactInputBeforeFee(input, edge.orders[index].order);
      if (!orderQuote.complete || orderQuote.amountOut <= 0n) return incomplete(amountIn);
      amountOutBeforeFee += orderQuote.amountOut;
      allocations?.push({ strategyId: edge.orders[index].strategyId, amountIn: input });
    }

    if (remaining > 0n || amountOutBeforeFee <= 0n) return incomplete(amountIn, amountOutBeforeFee);
    const amountOut = subtractFee(amountOutBeforeFee, edge.fee);
    return { amountIn, amountOut, profit: amountOut - amountIn, complete: amountOut > 0n };
  }
}

function incomplete(amountIn: bigint, amountOut = 0n): MarketRouteQuote {
  return { amountIn, amountOut, profit: -1n, complete: false };
}

export function quoteCarbonExactInput(amountIn: bigint, order: CarbonOrder, feePpm = 0): CarbonQuote {
  const quote = quoteCarbonExactInputBeforeFee(amountIn, order);
  if (!quote.complete) return quote;

  const amountOut = subtractFee(quote.amountOut, feePpm);
  return { amountIn, amountOut, complete: amountOut > 0n };
}

export function quoteCarbonExactInputBeforeFee(amountIn: bigint, order: CarbonOrder): CarbonQuote {
  if (amountIn <= 0n || amountIn >= (1n << 128n) || order.y <= 0n || order.z <= 0n ||
      order.y >= (1n << 128n) || order.z >= (1n << 128n) || order.y > order.z ||
      order.A < 0n || order.B < 0n || (order.A >> 48n) > 48n || (order.B >> 48n) > 48n) {
    return { amountIn, amountOut: 0n, complete: false };
  }

  const A = decodeCarbonRate(order.A);
  const B = decodeCarbonRate(order.B);
  const amountOutBeforeFee = calculateTargetAmount(amountIn, order.y, order.z, A, B);
  if (amountOutBeforeFee <= 0n || amountOutBeforeFee > order.y) {
    return { amountIn, amountOut: amountOutBeforeFee, complete: false };
  }

  return { amountIn, amountOut: amountOutBeforeFee, complete: true };
}

export function carbonMarginalRate(order: CarbonOrder, feePpm = 0): { numerator: bigint; denominator: bigint } {
  if (order.y <= 0n || order.z <= 0n) return { numerator: 0n, denominator: 0n };

  const A = decodeCarbonRate(order.A);
  const B = decodeCarbonRate(order.B);
  const curve = A * order.y + B * order.z;
  const numerator = curve * curve;
  const denominator = order.z * order.z * ONE * ONE;
  if (numerator <= 0n || denominator <= 0n) return { numerator: 0n, denominator: 0n };
  if (feePpm <= 0) return { numerator, denominator };

  return {
    numerator: numerator * feeFactor(feePpm),
    denominator: denominator * PPM,
  };
}

export function carbonMarginalRateAtSource(order: CarbonOrder, amountIn: bigint): { numerator: bigint; denominator: bigint } {
  if (order.y <= 0n || order.z <= 0n || amountIn < 0n) return { numerator: 0n, denominator: 0n };
  const A = decodeCarbonRate(order.A);
  const B = decodeCarbonRate(order.B);
  const curve = A * order.y + B * order.z;
  const scaledLiquidity = order.z * ONE;
  const denominator = A * amountIn * curve + scaledLiquidity * scaledLiquidity;
  return denominator <= 0n
    ? { numerator: 0n, denominator: 0n }
    : { numerator: curve * curve * scaledLiquidity * scaledLiquidity, denominator: denominator * denominator };
}

export function decodeCarbonRate(value: bigint): bigint {
  return (value & RATE_MANTISSA_MASK) << (value >> 48n);
}

export function carbonSourceAmountForFullOrder(order: CarbonOrder): bigint {
  if (order.y <= 0n || order.z <= 0n) return 0n;

  const A = decodeCarbonRate(order.A);
  const B = decodeCarbonRate(order.B);
  if (A === 0n) {
    if (B === 0n) return 0n;
    return divCeil(order.y * ONE * ONE, B * B);
  }

  const curve = A * order.y + B * order.z;
  const remainingCurve = curve - A * order.y;
  if (curve <= 0n || remainingCurve <= 0n) return 0n;

  return divCeil(order.y * order.z * order.z * ONE * ONE, curve * remainingCurve);
}

function calculateTargetAmount(amountIn: bigint, y: bigint, z: bigint, A: bigint, B: bigint): bigint {
  if (A === 0n) {
    if (B === 0n) return 0n;
    return amountIn * B * B / (ONE * ONE);
  }

  const curve = A * y + B * z;
  if (curve <= 0n) return 0n;

  const scaledLiquidity = z * ONE;
  // Match Carbon Strategies._calculateTradeTargetAmount, including its
  // uint256 scaling/rounding branches; the unbounded rational is not exact.
  // https://github.com/bancorprotocol/carbon-contracts/blob/dev/contracts/carbon/Strategies.sol
  const max = (1n << 256n) - 1n;
  const product = curve * amountIn;
  if (product > max) return 0n;
  const square = scaledLiquidity * scaledLiquidity;
  const curved = product * A;
  const scale = (value: bigint) => { const high = value >> 256n; return high + ((value & max) + high > max ? 2n : 1n); };
  const squareScale = scale(square), curvedScale = scale(curved);
  const factor = squareScale > curvedScale ? squareScale : curvedScale;
  const denominator = divCeil(square, factor) + divCeil(curved, factor);
  return denominator <= max
    ? curve * (product / factor) / denominator
    : curve / (A + divCeil(square, product));
}

function divCeil(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) return 0n;
  return numerator === 0n ? 0n : ((numerator - 1n) / denominator) + 1n;
}

function subtractFee(amount: bigint, feePpm: number): bigint {
  return amount * feeFactor(feePpm) / PPM;
}

function feeFactor(feePpm: number): bigint {
  if (feePpm <= 0) return PPM;
  if (feePpm >= Number(PPM)) return 0n;
  return PPM - BigInt(feePpm);
}
