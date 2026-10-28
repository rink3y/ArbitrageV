import { describe, expect, test } from 'bun:test';
import { carbonMarginalRate, decodeCarbonRate, quoteCarbonExactInput } from '../src/protocols/carbon/quote';

const ONE = 1n << 48n;

describe('Carbon swap math', () => {
  test('quotes exact input with the implemented Carbon formula', () => {
    const order = { y: 100n, z: 100n, A: 0n, B: encodeExpandedRate(2n * ONE) };

    expect(quoteCarbonExactInput(5n, order)).toEqual({
      amountIn: 5n,
      amountOut: 20n,
      complete: true,
    });
    expect(carbonMarginalRate(order)).toEqual({
      numerator: 40000n * ONE * ONE,
      denominator: 10000n * ONE * ONE,
    });
  });

  test('rejects empty liquidity', () => {
    expect(quoteCarbonExactInput(5n, { y: 0n, z: 10n, A: 0n, B: encodeExpandedRate(2n * ONE) }).complete).toBe(false);
  });

  test('subtracts Carbon fee in ppm from target output', () => {
    const order = { y: 100n, z: 100n, A: 0n, B: encodeExpandedRate(2n * ONE) };

    expect(quoteCarbonExactInput(5n, order, 4000)).toEqual({
      amountIn: 5n,
      amountOut: 19n,
      complete: true,
    });
    expect(carbonMarginalRate(order, 4000)).toEqual({
      numerator: 40000n * ONE * ONE * 996000n,
      denominator: 10000n * ONE * ONE * 1000000n,
    });
  });

  test('keeps the Carbon 2^48 rate scale in curved orders', () => {
    const order = {
      y: 100n,
      z: 100n,
      A: encodeExpandedRate(ONE),
      B: encodeExpandedRate(ONE),
    };

    expect(quoteCarbonExactInput(10n, order)).toEqual({
      amountIn: 10n,
      amountOut: 33n,
      complete: true,
    });
  });

  test('decodes packed Carbon rates', () => {
    expect(decodeCarbonRate((1n << 48n) | 1n)).toBe(2n);
  });
});

function encodeExpandedRate(value: bigint): bigint {
  let shift = 0n;
  let mantissa = value;
  while (mantissa >= ONE) {
    mantissa >>= 1n;
    shift++;
  }
  return mantissa | (shift << 48n);
}
