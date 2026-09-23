import { describe, expect, test } from "bun:test";
import { NETWORK, TOKENS } from "../src/constants";
import { graphToken, NATIVE_TOKEN } from "../src/tokens";
import { splitCostsFromConstants } from '../src/opportunities/split-costs';
import { tokenAmount } from "../src/values";

describe("token aliases", () => {
  test("uses the configured wrapped native token for graph aliases and gas conversion", () => {
    const previous = NETWORK.wrappedNativeToken;
    const wrapped = '0x0000000000000000000000000000000000000123';
    try {
      Object.assign(NETWORK, { wrappedNativeToken: wrapped });
      expect(graphToken(NATIVE_TOKEN)).toBe(wrapped);
      expect(graphToken(wrapped)).toBe(wrapped);
      expect(graphToken(previous)).toBe(previous);
      const costs = splitCostsFromConstants([], 1000);
      expect(costs.rates[wrapped]).toEqual({ numerator: 1n, denominator: 1n });
      expect(costs.rates[previous.toLowerCase()]).toBeUndefined();
    } finally {
      Object.assign(NETWORK, { wrappedNativeToken: previous });
    }
  });

  test("stores configured amounts in each token's native decimals", () => {
    const usdc = TOKENS.find(token => token.name === "USDC")!;
    const wbtc = TOKENS.find(token => token.name === "WBTC")!;

    expect(usdc.minProfit).toBe(tokenAmount("0.09", 6));
    expect(wbtc.liquidityAmount).toBe(tokenAmount("0.0003324", 8));
  });
});
