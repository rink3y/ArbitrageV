import { expect, test } from "bun:test";
import { type Address } from "viem";
import { TOKENS } from "../src/constants";
import { type CarbonStrategy } from "../src/protocols/carbon/types";
import { type ArbitrageSearchPolicy } from "../src/market-graph/types";
import { type PairInfo } from "../src/protocols/v2/types";
import { type V3PoolConfig } from "../src/protocols/v3/types";
import { OpportunityEngine } from "../src/opportunities/opportunity-engine";
import { Q96 } from "../src/protocols/v3/quote";

const [tokenA, tokenB] = TOKENS.map(token => token.address);
const controller = address(1);
const v2Pair = address(2);
const ONE = 1n << 48n;

function policy(maxRouteEdges: number): ArbitrageSearchPolicy {
  return {
  topTokens: 1,
  allowedProtocols: ["v2", "v3", "carbon"],
  allowProtocolMixing: true,
  maxRouteEdges,
  beamWidth: 8,
  optimizationIterations: 32,
  maxInputReserveFraction: 5n,
  maxOpportunities: 4,
  };
}

test("finds a profitable mixed Carbon and V2 route", () => {
  const searchPolicy = policy(2);
  const engine = new OpportunityEngine(searchPolicy, []);
  engine.graph.addPair({
    pairAddress: v2Pair,
    token0: tokenA,
    token1: tokenB,
    fee: 30,
    reserve0: 10n ** 30n,
    reserve1: 10n ** 24n,
    variant: 'uniswap-v2',
    scale0: 1n,
    scale1: 1n,
  } satisfies PairInfo);
  engine.graph.setCarbonStrategies([carbonStrategy()]);

  const opportunities = engine.findOpportunities({ startTokens: [tokenA] });

  expect(opportunities.length).toBeGreaterThan(0);
  expect(opportunities[0].protocols).toEqual(["carbon", "v2"]);
  expect(opportunities[0].pairs).toEqual([controller, v2Pair]);
});

test("finds a profitable mixed Carbon and V3 route", () => {
  const searchPolicy = policy(2);
  const engine = new OpportunityEngine(searchPolicy, []);
  addV3Pool(engine, address(4), tokenA, tokenB);
  engine.graph.setCarbonStrategies([carbonStrategy()]);

  const opportunities = engine.findOpportunities({ startTokens: [tokenA] });

  expect(opportunities.length).toBeGreaterThan(0);
  expect(opportunities[0].protocols).toEqual(["carbon", "v3"]);
});

test("finds a profitable mixed Carbon, V2, and V3 route", () => {
  const searchPolicy = policy(3);
  const engine = new OpportunityEngine(searchPolicy, []);
  engine.graph.addPair({
    pairAddress: v2Pair,
    token0: tokenB,
    token1: TOKENS[2].address,
    fee: 30,
    reserve0: 10n ** 24n,
    reserve1: 10n ** 30n,
    variant: 'uniswap-v2',
    scale0: 1n,
    scale1: 1n,
  } satisfies PairInfo);
  addV3Pool(engine, address(5), TOKENS[2].address, tokenA);
  engine.graph.setCarbonStrategies([carbonStrategy()]);

  const opportunities = engine.findOpportunities({ startTokens: [tokenA] });

  expect(opportunities.length).toBeGreaterThan(0);
  expect(opportunities[0].protocols).toEqual(["carbon", "v2", "v3"]);
});

function carbonStrategy(): CarbonStrategy {
  return {
    id: 1n,
    owner: address(3),
    controller,
    token0: tokenA,
    token1: tokenB,
    feePpm: 0,
    orders: [
      { y: 0n, z: 0n, A: 0n, B: 0n },
      { y: 10n ** 27n, z: 10n, A: 0n, B: encodeExpandedRate(2n * ONE) },
    ],
  };
}

function addV3Pool(engine: OpportunityEngine, poolAddress: Address, token0: Address, token1: Address): void {
  const pool: V3PoolConfig = {
    name: "carbon-mixed",
    address: poolAddress,
    token0,
    token1,
    fee: 500,
    tickSpacing: 10,
    enabled: true,
  };
  engine.graph.addV3Pool(pool);
  engine.graph.updateV3PoolStates([{
    poolAddress,
    sqrtPriceX96: Q96 / 2n,
    liquidity: 10n ** 30n,
    tick: 0,
  }]);
}

function address(id: number): Address {
  return `0x${(90_000_000 + id).toString(16).padStart(40, "0")}` as Address;
}

function encodeExpandedRate(value: bigint): bigint {
  let shift = 0n;
  let mantissa = value;
  while (mantissa >= ONE) {
    mantissa >>= 1n;
    shift++;
  }
  return mantissa | (shift << 48n);
}
