import { NETWORK } from '../src/constants';
import { describe, expect, test } from "bun:test";
import { filterDiscoveredMarkets, marketTokens } from "../src/market-filter";
import { NATIVE_TOKEN } from "../src/tokens";

const WRAPPED_NATIVE = NETWORK.wrappedNativeToken;

type Address = `0x${string}`;

const tokenA = "0x00000000000000000000000000000000000000a1" as Address;
const tokenB = "0x00000000000000000000000000000000000000b1" as Address;
const tokenC = "0x00000000000000000000000000000000000000c1" as Address;
const tokenD = "0x00000000000000000000000000000000000000d1" as Address;

describe("filterDiscoveredMarkets", () => {
  test("builds a token universe from discovered v2 and configured v3 markets", () => {
    const tokens = marketTokens(
      [{
        pairAddress: "0x0000000000000000000000000000000000001001" as Address,
        token0: WRAPPED_NATIVE,
        token1: tokenA,
        fee: 30,
        factory: "v2",
        variant: 'uniswap-v2',
        scale0: 1n,
        scale1: 1n,
      }],
      [{
        name: "v3",
        address: "0x0000000000000000000000000000000000001002" as Address,
        token0: NATIVE_TOKEN,
        token1: tokenB,
        fee: 500,
        tickSpacing: 10,
        enabled: true,
      }]
    ).map(token => token.toLowerCase());

    expect(tokens).toContain(WRAPPED_NATIVE.toLowerCase());
    expect(tokens).toContain(tokenA.toLowerCase());
    expect(tokens).toContain(tokenB.toLowerCase());
    expect(tokens).not.toContain(NATIVE_TOKEN.toLowerCase());
  });

  test("counts native currency and its wrapped token as the same token across protocols", () => {
    const filtered = filterDiscoveredMarkets(
      [{
        pairAddress: "0x0000000000000000000000000000000000001001" as Address,
        token0: WRAPPED_NATIVE,
        token1: tokenA,
        fee: 30,
        factory: "v2",
        variant: 'uniswap-v2',
        scale0: 1n,
        scale1: 1n,
      }],
      [{
        name: "v3",
        address: "0x0000000000000000000000000000000000001002" as Address,
        token0: tokenA,
        token1: tokenB,
        fee: 500,
        tickSpacing: 10,
        enabled: true,
      }],
      [
        {
          controller: "0x0000000000000000000000000000000000001003" as Address,
          token0: NATIVE_TOKEN,
          token1: tokenB,
          strategyCount: 1,
          feePpm: 4000,
        },
        {
          controller: "0x0000000000000000000000000000000000001003" as Address,
          token0: tokenC,
          token1: tokenD,
          strategyCount: 1,
          feePpm: 4000,
        },
      ]
    );

    expect(filtered.v2Pools).toHaveLength(1);
    expect(filtered.v3Pools).toHaveLength(1);
    expect(filtered.carbonPairs).toHaveLength(1);
    expect(filtered.carbonPairs[0].token0).toBe(NATIVE_TOKEN);
  });
});
