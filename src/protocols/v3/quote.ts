import { type V3SwapDirection, type V3Tick } from './types';

export const Q96 = 2n ** 96n;
export const V3_FEE_DENOMINATOR = 1_000_000n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

const Q128 = 2n ** 128n;
const MAX_UINT256 = (1n << 256n) - 1n;

export type V3SingleRangeQuoteRequest = {
  amountIn: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  fee: number;
  direction: V3SwapDirection;
};

export type V3SingleRangeQuote = {
  amountIn: bigint;
  amountInAfterFee: bigint;
  amountOut: bigint;
  sqrtPriceX96After: bigint;
};

export type V3MultiRangeQuoteRequest = V3SingleRangeQuoteRequest & {
  tick: number;
  ticks: readonly V3Tick[] | Map<number, V3Tick>;
  normalizedTicks?: boolean;
  fullRange?: boolean;
  sqrtPriceLimitX96?: bigint;
  spendWork?: () => boolean;
};

export type V3MultiRangeQuote = V3SingleRangeQuote & {
  liquidityAfter: bigint;
  tickAfter: number;
  initializedTicksCrossed: number;
  exhaustedLiquidity: boolean;
};

export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('denominator must be positive');
  return (a * b) / denominator;
}

export function divRoundingUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('denominator must be positive');
  return numerator === 0n ? 0n : ((numerator - 1n) / denominator) + 1n;
}

export function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
  return divRoundingUp(a * b, denominator);
}

export function amountAfterV3Fee(amountIn: bigint, fee: number): bigint {
  if (amountIn < 0n) throw new Error('amountIn must be non-negative');
  if (fee < 0 || fee >= Number(V3_FEE_DENOMINATOR)) throw new Error('invalid V3 fee');
  return (amountIn * (V3_FEE_DENOMINATOR - BigInt(fee))) / V3_FEE_DENOMINATOR;
}

export function grossAmountForV3Input(netAmountIn: bigint, fee: number): bigint {
  if (netAmountIn < 0n) throw new Error('netAmountIn must be non-negative');
  if (fee < 0 || fee >= Number(V3_FEE_DENOMINATOR)) throw new Error('invalid V3 fee');
  return mulDivRoundingUp(
    netAmountIn,
    V3_FEE_DENOMINATOR,
    V3_FEE_DENOMINATOR - BigInt(fee)
  );
}

export function getSqrtRatioAtTick(tick: number): bigint {
  if (tick < MIN_TICK || tick > MAX_TICK) throw new Error('tick out of range');

  const absTick = tick < 0 ? -tick : tick;
  let ratio = (absTick & 0x1) !== 0
    ? 0xfffcb933bd6fad37aa2d162d1a594001n
    : 0x100000000000000000000000000000000n;

  if ((absTick & 0x2) !== 0) ratio = (ratio * 0xfff97272373d413259a46990580e213an) / Q128;
  if ((absTick & 0x4) !== 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) / Q128;
  if ((absTick & 0x8) !== 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) / Q128;
  if ((absTick & 0x10) !== 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) / Q128;
  if ((absTick & 0x20) !== 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) / Q128;
  if ((absTick & 0x40) !== 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) / Q128;
  if ((absTick & 0x80) !== 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) / Q128;
  if ((absTick & 0x100) !== 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) / Q128;
  if ((absTick & 0x200) !== 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) / Q128;
  if ((absTick & 0x400) !== 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) / Q128;
  if ((absTick & 0x800) !== 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) / Q128;
  if ((absTick & 0x1000) !== 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) / Q128;
  if ((absTick & 0x2000) !== 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) / Q128;
  if ((absTick & 0x4000) !== 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) / Q128;
  if ((absTick & 0x8000) !== 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) / Q128;
  if ((absTick & 0x10000) !== 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) / Q128;
  if ((absTick & 0x20000) !== 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) / Q128;
  if ((absTick & 0x40000) !== 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) / Q128;
  if ((absTick & 0x80000) !== 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) / Q128;

  if (tick > 0) ratio = MAX_UINT256 / ratio;

  const remainder = ratio % (1n << 32n);
  return (ratio >> 32n) + (remainder === 0n ? 0n : 1n);
}

export function getAmount0Delta(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
  roundUp: boolean
): bigint {
  assertPriceAndLiquidity(sqrtRatioAX96, liquidity);
  assertPriceAndLiquidity(sqrtRatioBX96, liquidity);

  const [sqrtA, sqrtB] = sortSqrtRatios(sqrtRatioAX96, sqrtRatioBX96);
  const numerator1 = liquidity * Q96;
  const numerator2 = sqrtB - sqrtA;

  return roundUp
    ? divRoundingUp(mulDivRoundingUp(numerator1, numerator2, sqrtB), sqrtA)
    : (numerator1 * numerator2) / sqrtB / sqrtA;
}

export function getAmount1Delta(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
  roundUp: boolean
): bigint {
  assertPriceAndLiquidity(sqrtRatioAX96, liquidity);
  assertPriceAndLiquidity(sqrtRatioBX96, liquidity);

  const [sqrtA, sqrtB] = sortSqrtRatios(sqrtRatioAX96, sqrtRatioBX96);
  const delta = sqrtB - sqrtA;
  return roundUp
    ? mulDivRoundingUp(liquidity, delta, Q96)
    : mulDiv(liquidity, delta, Q96);
}

export function getNextSqrtPriceFromAmount0RoundingUp(
  sqrtPriceX96: bigint,
  liquidity: bigint,
  amount: bigint,
  add: boolean
): bigint {
  assertPriceAndLiquidity(sqrtPriceX96, liquidity);
  if (amount < 0n) throw new Error('amount must be non-negative');
  if (amount === 0n) return sqrtPriceX96;

  const numerator1 = liquidity * Q96;
  const product = amount * sqrtPriceX96;

  if (add) {
    const denominator = numerator1 + product;
    return mulDivRoundingUp(numerator1, sqrtPriceX96, denominator);
  }

  if (product >= numerator1) throw new Error('amount removes too much token0');
  return mulDivRoundingUp(numerator1, sqrtPriceX96, numerator1 - product);
}

export function getNextSqrtPriceFromAmount1RoundingDown(
  sqrtPriceX96: bigint,
  liquidity: bigint,
  amount: bigint,
  add: boolean
): bigint {
  assertPriceAndLiquidity(sqrtPriceX96, liquidity);
  if (amount < 0n) throw new Error('amount must be non-negative');
  if (amount === 0n) return sqrtPriceX96;

  if (add) {
    return sqrtPriceX96 + mulDiv(amount, Q96, liquidity);
  }

  const quotient = mulDivRoundingUp(amount, Q96, liquidity);
  if (sqrtPriceX96 <= quotient) throw new Error('amount removes too much token1');
  return sqrtPriceX96 - quotient;
}

export function quoteV3SingleRangeExactInput(request: V3SingleRangeQuoteRequest): V3SingleRangeQuote {
  if (request.amountIn <= 0n) {
    return {
      amountIn: request.amountIn,
      amountInAfterFee: 0n,
      amountOut: 0n,
      sqrtPriceX96After: request.sqrtPriceX96,
    };
  }

  const amountInAfterFee = amountAfterV3Fee(request.amountIn, request.fee);
  if (amountInAfterFee === 0n) {
    return {
      amountIn: request.amountIn,
      amountInAfterFee,
      amountOut: 0n,
      sqrtPriceX96After: request.sqrtPriceX96,
    };
  }

  if (request.direction === 'token0ToToken1') {
    const sqrtPriceX96After = getNextSqrtPriceFromAmount0RoundingUp(
      request.sqrtPriceX96,
      request.liquidity,
      amountInAfterFee,
      true
    );
    const amountOut = getAmount1Delta(
      sqrtPriceX96After,
      request.sqrtPriceX96,
      request.liquidity,
      false
    );

    return {
      amountIn: request.amountIn,
      amountInAfterFee,
      amountOut,
      sqrtPriceX96After,
    };
  }

  const sqrtPriceX96After = getNextSqrtPriceFromAmount1RoundingDown(
    request.sqrtPriceX96,
    request.liquidity,
    amountInAfterFee,
    true
  );
  const amountOut = getAmount0Delta(
    request.sqrtPriceX96,
    sqrtPriceX96After,
    request.liquidity,
    false
  );

  return {
    amountIn: request.amountIn,
    amountInAfterFee,
    amountOut,
    sqrtPriceX96After,
  };
}

export function quoteV3MultiRangeExactInput(request: V3MultiRangeQuoteRequest): V3MultiRangeQuote {
  if (request.amountIn <= 0n) {
    return {
      amountIn: request.amountIn,
      amountInAfterFee: 0n,
      amountOut: 0n,
      sqrtPriceX96After: request.sqrtPriceX96,
      liquidityAfter: request.liquidity,
      tickAfter: request.tick,
      initializedTicksCrossed: 0,
      exhaustedLiquidity: false,
    };
  }

  const zeroForOne = request.direction === 'token0ToToken1';
  const initializedTicks = request.normalizedTicks && Array.isArray(request.ticks)
    ? request.ticks as V3Tick[]
    : normalizeTicks(request.ticks);
  let amountRemaining = request.amountIn;
  let amountInAfterFee = 0n;
  let amountOut = 0n;
  let sqrtPriceX96 = request.sqrtPriceX96;
  let liquidity = request.liquidity;
  let tick = request.tick;
  let initializedTicksCrossed = 0;

  while (amountRemaining > 0n) {
    if (request.spendWork && !request.spendWork()) {
      return finishMultiRangeQuote(request.amountIn, amountInAfterFee, amountOut, sqrtPriceX96, liquidity, tick, initializedTicksCrossed, true);
    }
    const nextTick = nextInitializedTick(initializedTicks, tick, zeroForOne);
    if (liquidity <= 0n) {
      // A complete bitmap distinguishes an empty interval from missing data.
      // Crossing that interval consumes no tokens; liquidity resumes at its end.
      if (liquidity === 0n && request.fullRange && nextTick) {
        sqrtPriceX96 = boundedTargetSqrtPrice(getSqrtRatioAtTick(nextTick.index), request.sqrtPriceLimitX96, zeroForOne);
        if (sqrtPriceX96 !== request.sqrtPriceLimitX96) {
          liquidity = applyLiquidityNet(0n, zeroForOne ? -nextTick.liquidityNet : nextTick.liquidityNet);
          tick = zeroForOne ? nextTick.index - 1 : nextTick.index;
          initializedTicksCrossed++;
          continue;
        }
      }
      return finishMultiRangeQuote(request.amountIn, amountInAfterFee, amountOut, sqrtPriceX96, liquidity, tick, initializedTicksCrossed, true);
    }

    const boundarySqrtPriceX96 = boundedTargetSqrtPrice(
      nextTick ? getSqrtRatioAtTick(nextTick.index) : null,
      request.sqrtPriceLimitX96,
      zeroForOne
    );

    const netInputToBoundary = zeroForOne
      ? getAmount0Delta(boundarySqrtPriceX96, sqrtPriceX96, liquidity, true)
      : getAmount1Delta(sqrtPriceX96, boundarySqrtPriceX96, liquidity, true);
    const availableNetInput = amountAfterV3Fee(amountRemaining, request.fee);

    if (availableNetInput < netInputToBoundary) {
      const quote = quoteV3SingleRangeExactInput({
        amountIn: amountRemaining,
        sqrtPriceX96,
        liquidity,
        fee: request.fee,
        direction: request.direction,
      });

      return finishMultiRangeQuote(
        request.amountIn,
        amountInAfterFee + quote.amountInAfterFee,
        amountOut + quote.amountOut,
        quote.sqrtPriceX96After,
        liquidity,
        tick,
        initializedTicksCrossed,
        false
      );
    }

    const grossInputToBoundary = grossAmountForV3Input(netInputToBoundary, request.fee);
    amountRemaining -= grossInputToBoundary;
    amountInAfterFee += netInputToBoundary;
    amountOut += zeroForOne
      ? getAmount1Delta(boundarySqrtPriceX96, sqrtPriceX96, liquidity, false)
      : getAmount0Delta(sqrtPriceX96, boundarySqrtPriceX96, liquidity, false);
    sqrtPriceX96 = boundarySqrtPriceX96;

    if (!nextTick || sqrtPriceX96 === request.sqrtPriceLimitX96) {
      return finishMultiRangeQuote(request.amountIn, amountInAfterFee, amountOut, sqrtPriceX96, liquidity, tick, initializedTicksCrossed, true);
    }

    liquidity = applyLiquidityNet(liquidity, zeroForOne ? -nextTick.liquidityNet : nextTick.liquidityNet);
    tick = zeroForOne ? nextTick.index - 1 : nextTick.index;
    initializedTicksCrossed++;
  }

  return finishMultiRangeQuote(request.amountIn, amountInAfterFee, amountOut, sqrtPriceX96, liquidity, tick, initializedTicksCrossed, false);
}

function sortSqrtRatios(a: bigint, b: bigint): [bigint, bigint] {
  return a <= b ? [a, b] : [b, a];
}

function assertPriceAndLiquidity(sqrtPriceX96: bigint, liquidity: bigint): void {
  if (sqrtPriceX96 <= 0n) throw new Error('sqrtPriceX96 must be positive');
  if (liquidity <= 0n) throw new Error('liquidity must be positive');
}

function normalizeTicks(ticks: readonly V3Tick[] | Map<number, V3Tick>): V3Tick[] {
  const list = ticks instanceof Map ? Array.from(ticks.values()) : [...ticks];
  return list
    .filter(tick => tick.liquidityGross > 0n)
    .sort((a, b) => a.index - b.index);
}

function nextInitializedTick(ticks: V3Tick[], currentTick: number, zeroForOne: boolean): V3Tick | null {
  let low = 0;
  let high = ticks.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ticks[middle].index <= currentTick) low = middle + 1;
    else high = middle;
  }

  if (zeroForOne) return low > 0 ? ticks[low - 1] : null;
  return ticks[low] ?? null;
}

function boundedTargetSqrtPrice(
  nextTickSqrtPriceX96: bigint | null,
  sqrtPriceLimitX96: bigint | undefined,
  zeroForOne: boolean
): bigint {
  const defaultLimit = zeroForOne ? MIN_SQRT_RATIO : MAX_SQRT_RATIO;
  const limit = sqrtPriceLimitX96 ?? defaultLimit;
  if (!nextTickSqrtPriceX96) return limit;
  return zeroForOne
    ? maxBigint(nextTickSqrtPriceX96, limit)
    : minBigint(nextTickSqrtPriceX96, limit);
}

function applyLiquidityNet(liquidity: bigint, liquidityNet: bigint): bigint {
  if (liquidityNet < 0n) {
    const removed = -liquidityNet;
    if (liquidity < removed) throw new Error('liquidity underflow crossing V3 tick');
    return liquidity - removed;
  }

  return liquidity + liquidityNet;
}

function finishMultiRangeQuote(
  amountIn: bigint,
  amountInAfterFee: bigint,
  amountOut: bigint,
  sqrtPriceX96After: bigint,
  liquidityAfter: bigint,
  tickAfter: number,
  initializedTicksCrossed: number,
  exhaustedLiquidity: boolean
): V3MultiRangeQuote {
  return {
    amountIn,
    amountInAfterFee,
    amountOut,
    sqrtPriceX96After,
    liquidityAfter,
    tickAfter,
    initializedTicksCrossed,
    exhaustedLiquidity,
  };
}

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function maxBigint(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
