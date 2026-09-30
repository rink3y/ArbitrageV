import { describe, expect, test } from "bun:test";
import {
  amountAfterV3Fee,
  getAmount0Delta,
  getAmount1Delta,
  getNextSqrtPriceFromAmount0RoundingUp,
  getNextSqrtPriceFromAmount1RoundingDown,
  getSqrtRatioAtTick,
  grossAmountForV3Input,
  MAX_SQRT_RATIO,
  MIN_SQRT_RATIO,
  Q96,
  quoteV3MultiRangeExactInput,
  quoteV3SingleRangeExactInput,
} from "../src/protocols/v3/quote";

describe("V3 swap math", () => {
  test('exact-input price helpers preserve rounding and reject invalid inputs', () => {
    expect(getNextSqrtPriceFromAmount0RoundingUp(Q96, 1000n, 1n)).toBe((1000n * Q96 + 1000n) / 1001n);
    expect(getNextSqrtPriceFromAmount1RoundingDown(Q96, 1000n, 1n)).toBe(Q96 + Q96 / 1000n);
    for (const nextPrice of [getNextSqrtPriceFromAmount0RoundingUp, getNextSqrtPriceFromAmount1RoundingDown]) {
      expect(nextPrice(Q96, 1000n, 0n)).toBe(Q96);
      expect(() => nextPrice(Q96, 1000n, -1n)).toThrow('amount must be non-negative');
      expect(() => nextPrice(0n, 1000n, 1n)).toThrow('sqrtPriceX96 must be positive');
      expect(() => nextPrice(Q96, 0n, 1n)).toThrow('liquidity must be positive');
    }
  });

  for (const direction of ['token0ToToken1', 'token1ToToken0'] as const) {
    test(`crosses an empty interval only with full coverage: ${direction}`, () => {
      const left = direction === 'token0ToToken1';
      const liquidity = 1_000_000n;
      const request = {
        amountIn: 100n, sqrtPriceX96: Q96, liquidity: 0n, tick: 0, fee: 3000, direction,
        ticks: [
          { index: left ? -200 : 100, liquidityGross: liquidity, liquidityNet: liquidity },
          { index: left ? -100 : 200, liquidityGross: liquidity, liquidityNet: -liquidity },
        ],
      };
      expect(quoteV3MultiRangeExactInput(request).exhaustedLiquidity).toBe(true);
      const quote = quoteV3MultiRangeExactInput({ ...request, fullRange: true });
      expect(quote.exhaustedLiquidity).toBe(false);
      expect(quote.amountOut).toBeGreaterThan(0n);
      expect(quote.initializedTicksCrossed).toBe(1);
      expect(quote.liquidityAfter).toBe(liquidity);
    });
  }

  test('retains initialized ticks whose net liquidity is zero', () => {
    const quote = quoteV3MultiRangeExactInput({
      amountIn: 1000n, sqrtPriceX96: Q96, liquidity: 1000n, tick: 0, fee: 3000,
      direction: 'token1ToToken0', fullRange: true,
      ticks: [
        { index: 60, liquidityGross: 2000n, liquidityNet: 0n },
        { index: 120, liquidityGross: 1000n, liquidityNet: -1000n },
      ],
    });
    expect(quote.initializedTicksCrossed).toBe(2);
    expect(quote.exhaustedLiquidity).toBe(true);
  });

  test("applies V3 fee units with bigint precision", () => {
    expect(amountAfterV3Fee(1_000_000n, 500)).toBe(999_500n);
    expect(amountAfterV3Fee(1_000_000n, 3000)).toBe(997_000n);
    expect(amountAfterV3Fee(1_000_000n, 10_000)).toBe(990_000n);
  });

  test("calculates token deltas between sqrt price ranges", () => {
    const liquidity = 1_000n;
    const sqrtA = Q96;
    const sqrtB = Q96 * 2n;

    expect(getAmount0Delta(sqrtA, sqrtB, liquidity, false)).toBe(500n);
    expect(getAmount1Delta(sqrtA, sqrtB, liquidity, false)).toBe(1_000n);
  });

  test("calculates known sqrt ratios for tick boundaries", () => {
    expect(getSqrtRatioAtTick(0)).toBe(Q96);
    expect(getSqrtRatioAtTick(-887272)).toBe(MIN_SQRT_RATIO);
    expect(getSqrtRatioAtTick(887272)).toBe(MAX_SQRT_RATIO);
  });

  test("quotes token0 to token1 exact input inside the active range", () => {
    const quote = quoteV3SingleRangeExactInput({
      amountIn: 1_000n,
      sqrtPriceX96: Q96,
      liquidity: 1_000_000n,
      fee: 3000,
      direction: "token0ToToken1",
    });

    expect(quote.amountInAfterFee).toBe(997n);
    expect(quote.amountOut).toBeGreaterThan(0n);
    expect(quote.sqrtPriceX96After).toBeLessThan(Q96);
  });

  test("quotes token1 to token0 exact input inside the active range", () => {
    const quote = quoteV3SingleRangeExactInput({
      amountIn: 1_000n,
      sqrtPriceX96: Q96,
      liquidity: 1_000_000n,
      fee: 3000,
      direction: "token1ToToken0",
    });

    expect(quote.amountInAfterFee).toBe(997n);
    expect(quote.amountOut).toBeGreaterThan(0n);
    expect(quote.sqrtPriceX96After).toBeGreaterThan(Q96);
  });

  test("keeps precision with very large liquidity and input values", () => {
    const quote = quoteV3SingleRangeExactInput({
      amountIn: 10n ** 24n,
      sqrtPriceX96: Q96,
      liquidity: 10n ** 30n,
      fee: 500,
      direction: "token0ToToken1",
    });

    expect(typeof quote.amountOut).toBe("bigint");
    expect(typeof quote.sqrtPriceX96After).toBe("bigint");
    expect(quote.amountInAfterFee).toBe(999_500_000_000_000_000_000_000n);
    expect(quote.amountOut).toBeGreaterThan(0n);
    expect(quote.sqrtPriceX96After).toBeLessThan(Q96);
  });

  test("crosses a lower initialized tick for token0 to token1 swaps", () => {
    const lowerTick = -100;
    const liquidity = 1_000_000n;
    const sqrtStart = getSqrtRatioAtTick(0);
    const sqrtLower = getSqrtRatioAtTick(lowerTick);
    const netInputToLower = getAmount0Delta(sqrtLower, sqrtStart, liquidity, true);

    const quote = quoteV3MultiRangeExactInput({
      amountIn: grossAmountForV3Input(netInputToLower, 3000),
      sqrtPriceX96: sqrtStart,
      liquidity,
      tick: 0,
      fee: 3000,
      direction: "token0ToToken1",
      ticks: [{
        index: lowerTick,
        liquidityGross: liquidity,
        liquidityNet: liquidity,
      }],
    });

    expect(quote.initializedTicksCrossed).toBe(1);
    expect(quote.sqrtPriceX96After).toBe(sqrtLower);
    expect(quote.liquidityAfter).toBe(0n);
    expect(quote.tickAfter).toBe(lowerTick - 1);
    expect(quote.amountOut).toBe(getAmount1Delta(sqrtLower, sqrtStart, liquidity, false));
  });

  test("includes the initialized current tick when moving left", () => {
    const liquidity = 520_984_746_264n;
    const quote = quoteV3MultiRangeExactInput({
      amountIn: 2_433_032n,
      sqrtPriceX96: 79_208_358_942_307_134_520_351_225_250n,
      liquidity,
      tick: -5,
      fee: 100,
      direction: "token0ToToken1",
      ticks: [{ index: -5, liquidityGross: liquidity, liquidityNet: liquidity }],
    });

    expect(quote.initializedTicksCrossed).toBe(1);
    expect(quote.liquidityAfter).toBe(0n);
    expect(quote.exhaustedLiquidity).toBe(true);
  });

  test("crosses an initialized current tick at zero price distance", () => {
    const liquidity = 1_000_000n;
    const quote = quoteV3MultiRangeExactInput({
      amountIn: 1n,
      sqrtPriceX96: getSqrtRatioAtTick(-5),
      liquidity,
      tick: -5,
      fee: 0,
      direction: "token0ToToken1",
      ticks: [{ index: -5, liquidityGross: liquidity, liquidityNet: liquidity }],
    });

    expect(quote.initializedTicksCrossed).toBe(1);
    expect(quote.liquidityAfter).toBe(0n);
    expect(quote.exhaustedLiquidity).toBe(true);
  });

  test("crosses an upper initialized tick for token1 to token0 swaps", () => {
    const upperTick = 100;
    const liquidity = 1_000_000n;
    const sqrtStart = getSqrtRatioAtTick(0);
    const sqrtUpper = getSqrtRatioAtTick(upperTick);
    const netInputToUpper = getAmount1Delta(sqrtStart, sqrtUpper, liquidity, true);

    const quote = quoteV3MultiRangeExactInput({
      amountIn: grossAmountForV3Input(netInputToUpper, 3000),
      sqrtPriceX96: sqrtStart,
      liquidity,
      tick: 0,
      fee: 3000,
      direction: "token1ToToken0",
      ticks: [{
        index: upperTick,
        liquidityGross: liquidity,
        liquidityNet: -liquidity,
      }],
    });

    expect(quote.initializedTicksCrossed).toBe(1);
    expect(quote.sqrtPriceX96After).toBe(sqrtUpper);
    expect(quote.liquidityAfter).toBe(0n);
    expect(quote.tickAfter).toBe(upperTick);
    expect(quote.amountOut).toBe(getAmount0Delta(sqrtStart, sqrtUpper, liquidity, false));
  });

  test("continues across multiple initialized ticks until liquidity is exhausted", () => {
    const liquidity = 1_000_000n;
    const quote = quoteV3MultiRangeExactInput({
      amountIn: 10n ** 18n,
      sqrtPriceX96: getSqrtRatioAtTick(0),
      liquidity,
      tick: 0,
      fee: 3000,
      direction: "token1ToToken0",
      ticks: [
        {
          index: 100,
          liquidityGross: 500_000n,
          liquidityNet: 500_000n,
        },
        {
          index: 200,
          liquidityGross: 1_500_000n,
          liquidityNet: -1_500_000n,
        },
      ],
    });

    expect(quote.initializedTicksCrossed).toBe(2);
    expect(quote.tickAfter).toBe(200);
    expect(quote.liquidityAfter).toBe(0n);
    expect(quote.exhaustedLiquidity).toBe(true);
    expect(quote.amountOut).toBeGreaterThan(0n);
  });
});
