import { describe, expect, test } from "bun:test";
import { TOKENS, CONFIGURED_TOKENS, WRAPPED_NATIVE_TOKENS } from "../src/constants";
import { graphToken, NATIVE_TOKEN } from "../src/tokens";
import { splitCostsFromSnapshot } from '../src/opportunities/split-costs';

describe("token aliases", () => {
  test("wrapper metadata is included once before ordinary token preferences", () => {
    expect(CONFIGURED_TOKENS).toEqual([...WRAPPED_NATIVE_TOKENS, ...TOKENS]);
    for (const wrapper of WRAPPED_NATIVE_TOKENS) {
      expect(CONFIGURED_TOKENS.find(token => token.address === wrapper.address)).toBe(wrapper);
      expect(TOKENS.some(token => token.address.toLowerCase() === wrapper.address.toLowerCase())).toBe(false);
    }
    expect(new Set(CONFIGURED_TOKENS.map(token => token.address.toLowerCase())).size).toBe(CONFIGURED_TOKENS.length);
  });

  test("uses the configured wrapped native token for graph aliases and gas conversion", () => {
    const previous = WRAPPED_NATIVE_TOKENS[0].address;
    const wrapped = '0x0000000000000000000000000000000000000123';
    try {
      WRAPPED_NATIVE_TOKENS[0].address = wrapped;
      expect(graphToken(NATIVE_TOKEN)).toBe(wrapped);
      expect(graphToken(wrapped)).toBe(wrapped);
      expect(graphToken(previous)).toBe(previous);
      const costs = splitCostsFromSnapshot({ type: 'legacy', gasPrice: 1n, validUntil: 2000 }, 1000);
      expect(costs.rates[wrapped]).toEqual({ numerator: 1n, denominator: 1n });
      expect(costs.rates[previous.toLowerCase()]).toBeUndefined();
    } finally {
      WRAPPED_NATIVE_TOKENS[0].address = previous;
    }
  });

});
