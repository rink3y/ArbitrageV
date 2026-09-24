import { describe, expect, test } from "bun:test";
import { createExecutionPlan, flashLoanFee } from "../src/execution/execution-planner";
import { decodeFunctionData, encodeFunctionData } from "viem";
import ArbABI from "../src/ABI/Arb.json";

type Address = `0x${string}`;

const tokenA = address(101);
const tokenB = address(102);
const tokenC = address(103);

function address(id: number): Address {
  return `0x${(60_000_000 + id).toString(16).padStart(40, "0")}` as Address;
}

function carbonRouteData(strategyId: bigint, sourceToken: Address, targetToken: Address): `0x${string}` {
  return `0x${strategyId.toString(16).padStart(64, "0")}${sourceToken.slice(2).padStart(64, "0")}${targetToken.slice(2).padStart(64, "0")}`;
}

describe("createExecutionPlan", () => {
  test("calculates the exact flash repayment fee", () => {
    expect(flashLoanFee({ protocol: "v2", poolAddress: address(1), fee: 30, liquidity: 10_000n }, 1_000n)).toBe(4n);
    expect(flashLoanFee({ protocol: "v3", poolAddress: address(2), fee: 500, liquidity: 10_000n }, 1_000n)).toBe(1n);
    expect(flashLoanFee({ protocol: "v2", poolAddress: address(1), fee: 0, liquidity: 10_000n }, 200n)).toBe(0n);
    expect(flashLoanFee({ protocol: "v2", poolAddress: address(1), fee: 30, liquidity: 10_000n }, 997n)).toBe(3n);
  });

  test("builds ArbParams for a mixed V2/V3 circular route", () => {
    const flashPool = address(1);
    const v2Pool = address(2);
    const v3Pool = address(3);
    const closingPool = address(4);

    const plan = createExecutionPlan({
      findBestFlashPoolForToken(token, amountIn, excludePools) {
        expect(token).toBe(tokenA);
        expect(amountIn).toBe(1_000n);
        expect(excludePools).toEqual([v2Pool, v3Pool, closingPool]);
        return { protocol: "v2", poolAddress: flashPool, fee: 30, liquidity: 10_000n };
      },
    }, {
      path: [tokenA, tokenB, tokenC, tokenA],
      pairs: [v2Pool, v3Pool, closingPool],
      protocols: ["v2", "v3", "v2"],
      fees: [30, 500, 30],
      routeData: ["0x", "0x", "0x"],
      optimalInput: 1_000n,
      profit: 100n,
    });

    expect(plan?.params).toEqual({
      flashProtocol: 0,
      flashPool,
      borrowToken: tokenA,
      borrowAmount: 1_000n,
      v2RepayFee: 30n,
      pools: [v2Pool, v3Pool, closingPool],
      protocols: [0, 1, 0],
      fees: [30n, 500n, 30n],
      data: ["0x", "0x", "0x"],
    });
    const encoded = encodeFunctionData({ abi: ArbABI, functionName: 'executeArbitrage', args: [plan!.params] });
    expect(decodeFunctionData({ abi: ArbABI, data: encoded }).args![0]).toEqual(plan!.params);
  });

  test("builds ArbParams with a V3 flash pool when it is the best flash source", () => {
    const flashPool = address(30);
    const routePool = address(31);

    const plan = createExecutionPlan({
      findBestFlashPoolForToken() {
        return { protocol: "v3", poolAddress: flashPool, fee: 500, liquidity: 10_000n };
      },
    }, {
      path: [tokenA, tokenB, tokenA],
      pairs: [routePool, address(32)],
      protocols: ["v2", "v3"],
      fees: [30, 500],
      routeData: ["0x", "0x"],
      optimalInput: 1_000n,
      profit: 100n,
    });

    expect(plan?.params.flashProtocol).toBe(1);
    expect(plan?.params.flashPool).toBe(flashPool);
    expect(plan?.params.v2RepayFee).toBe(0n);
  });

  test("builds ArbParams for a route with a Carbon hop", () => {
    const flashPool = address(40);
    const carbonController = address(41);
    const v2Pool = address(42);
    const carbonData = carbonRouteData(123n, tokenA, tokenB);

    const plan = createExecutionPlan({
      findBestFlashPoolForToken(token, amountIn, excludePools) {
        expect(token).toBe(tokenA);
        expect(amountIn).toBe(1_000n);
        expect(excludePools).toEqual([carbonController, v2Pool]);
        return { protocol: "v2", poolAddress: flashPool, fee: 30, liquidity: 10_000n };
      },
    }, {
      path: [tokenA, tokenB, tokenA],
      pairs: [carbonController, v2Pool],
      protocols: ["carbon", "v2"],
      fees: [4000, 30],
      routeData: [carbonData, "0x"],
      optimalInput: 1_000n,
      profit: 100n,
    });

    expect(plan?.params).toEqual({
      flashProtocol: 0,
      flashPool,
      borrowToken: tokenA,
      borrowAmount: 1_000n,
      v2RepayFee: 30n,
      pools: [carbonController, v2Pool],
      protocols: [2, 0],
      fees: [4000n, 30n],
      data: [carbonData, "0x"],
    });
  });

  test("does not create a plan for non-circular routes", () => {
    const plan = createExecutionPlan({
      findBestFlashPoolForToken() {
        throw new Error("flash loan lookup should not run");
      },
    }, {
      path: [tokenA, tokenB, tokenC],
      pairs: [address(10), address(11)],
      protocols: ["v2", "v3"],
      fees: [30, 500],
      routeData: ["0x", "0x"],
      optimalInput: 1_000n,
      profit: 100n,
    });

    expect(plan).toBeNull();
  });

  test("does not create a plan when route metadata lengths do not match", () => {
    const plan = createExecutionPlan({
      findBestFlashPoolForToken() {
        throw new Error("flash loan lookup should not run");
      },
    }, {
      path: [tokenA, tokenB, tokenA],
      pairs: [address(20), address(21)],
      protocols: ["v2"],
      fees: [30, 30],
      routeData: ["0x", "0x"],
      optimalInput: 1_000n,
      profit: 100n,
    });

    expect(plan).toBeNull();
  });
});
