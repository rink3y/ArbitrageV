import { describe, expect, test } from "bun:test";
import { type Address } from "viem";
import { routeTokens } from './helpers/markets';
import { MarketGraph } from '../src/market-graph/market-graph';
import { type CarbonStrategy } from "../src/protocols/carbon/types";
import { type ArbitrageSearchPolicy } from "../src/market-graph/types";
import { v2Pair as pair } from './helpers/markets';
import { type V3PoolConfig } from "../src/protocols/v3/types";
import { OpportunityEngine } from "../src/opportunities/opportunity-engine";
import { Q96 } from "../src/protocols/v3/quote";

const [tokenA, tokenB] = routeTokens.map(token => token.address);
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
  engine.graph.addPair(pair(v2Pair, tokenA, tokenB, 10n ** 30n, 10n ** 24n));
  engine.graph.setCarbonStrategies([strategy()]);

  const opportunities = engine.findOpportunities({ startTokens: [tokenA] });

  expect(opportunities.length).toBeGreaterThan(0);
  expect(opportunities[0].protocols).toEqual(["carbon", "v2"]);
  expect(opportunities[0].pairs).toEqual([controller, v2Pair]);
});

test("finds a profitable mixed Carbon and V3 route", () => {
  const searchPolicy = policy(2);
  const engine = new OpportunityEngine(searchPolicy, []);
  addV3Pool(engine, address(4), tokenA, tokenB);
  engine.graph.setCarbonStrategies([strategy()]);

  const opportunities = engine.findOpportunities({ startTokens: [tokenA] });

  expect(opportunities.length).toBeGreaterThan(0);
  expect(opportunities[0].protocols).toEqual(["carbon", "v3"]);
});

test("finds a profitable mixed Carbon, V2, and V3 route", () => {
  const searchPolicy = policy(3);
  const engine = new OpportunityEngine(searchPolicy, []);
  engine.graph.addPair(pair(v2Pair, tokenB, routeTokens[2].address, 10n ** 24n, 10n ** 30n));
  addV3Pool(engine, address(5), routeTokens[2].address, tokenA);
  engine.graph.setCarbonStrategies([strategy()]);

  const opportunities = engine.findOpportunities({ startTokens: [tokenA] });

  expect(opportunities.length).toBeGreaterThan(0);
  expect(opportunities[0].protocols).toEqual(["carbon", "v2", "v3"]);
});

function strategy(id = 1n, y = 10n ** 27n): CarbonStrategy {
  return {
    id,
    owner: address(1000 + Number(id)),
    controller,
    token0: tokenA,
    token1: tokenB,
    feePpm: 0,
    orders: [
      { y: 0n, z: 0n, A: 0n, B: 0n },
      { y, z: y, A: 0n, B: encodeExpandedRate(2n * ONE) },
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

describe("Carbon grouped edges", () => {
  test("keeps single strategies and adds a grouped source-to-target edge", () => {
    const graph = new MarketGraph({ ...policy(2), allowedProtocols: ["carbon"] }, []);
    graph.setCarbonStrategies([
      strategy(1n, 100n),
      strategy(2n, 100n),
    ]);

    const groupId = `carbon-group:${controller.toLowerCase()}:${tokenA.toLowerCase()}:${tokenB.toLowerCase()}`;
    const quote = graph.quote({
      path: [tokenA, tokenB],
      pools: [controller],
      edgeIds: [groupId],
      protocols: ["carbon"],
    }, 40n);

    expect(quote).toMatchObject({
      amountIn: 40n,
      amountOut: 160n,
      complete: true,
    });

    const tokenIndex = graph.tokenIndexOf(tokenA);
    expect(tokenIndex).toBeNumber();
    const groupEdgeIndex = graph.rankedEdgeIndexes(tokenIndex!, 8)
      .find(edgeIndex => graph.edgeAt(edgeIndex)?.id === groupId);
    expect(groupEdgeIndex).toBeNumber();
    expect(graph.carbonExecution(groupEdgeIndex!, 40n)).toEqual({
      rawFrom: tokenA,
      rawTo: tokenB,
      strategyIds: [1n, 2n],
      amounts: [25n, 15n],
    });
  });
});
