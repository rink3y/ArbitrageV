import { describe, expect, test } from "bun:test";
import { decodeFunctionResult, encodeFunctionData, encodeFunctionResult, type Address } from "viem";
import UniswapFlashQueryABI from '../src/ABI/UniswapFlashQuery.json';
import { CONTRACTS } from '../src/constants';
import { EventMonitor } from "../src/runtime/event-monitor";
import { CarbonStrategyStore } from "../src/protocols/carbon/runtime";
import { type CarbonPairMetadata } from "../src/protocols/carbon/types";
import { CarbonEventAdapter } from "../src/protocols/carbon/runtime";
import { CARBON_CONTROLLERS } from "../src/protocols/carbon/config";

const controller = "0x0000000000000000000000000000000000000c01" as Address;
const token0 = "0x0000000000000000000000000000000000000c02" as Address;
const token1 = "0x0000000000000000000000000000000000000c03" as Address;

const pair: CarbonPairMetadata = {
  controller,
  token0,
  token1,
  strategyCount: 1,
  feePpm: 4000,
};

describe("CarbonStrategyStore events", () => {
  test('loads Carbon batches through the shared JSON query ABI', async () => {
    const previousAddress = CONTRACTS.flashQuery;
    Object.assign(CONTRACTS, { flashQuery: controller });
    let reads = 0;
    const store = new CarbonStrategyStore({
      readContract: async request => {
        reads++;
        expect(request.abi).toBe(UniswapFlashQueryABI);
        expect(request.functionName).toBe('getCarbonStrategiesByPairs');
        expect(encodeFunctionData(request)).toMatch(/^0x[0-9a-f]+$/);
        const data = encodeFunctionResult({
          abi: UniswapFlashQueryABI, functionName: request.functionName,
          result: [{ token0, token1, feePpm: 4000, strategies: [{
            id: 12n, owner: token0, tokens: [token0, token1], orders: [order(1000n), order(2000n)],
          }] }],
        });
        return decodeFunctionResult({ abi: UniswapFlashQueryABI, functionName: request.functionName, data });
      },
    }, [pair]);
    try {
      await store.loadAll();
      expect(reads).toBe(1);
      expect(store.stats()).toEqual({ strategyCount: 1, pairCount: 1 });
    } finally {
      Object.assign(CONTRACTS, { flashQuery: previousAddress });
    }
  });

  test("buffers Carbon with the same feed used after startup", async () => {
    const carbonController = CARBON_CONTROLLERS[0].address;
    const carbonPair = { ...pair, controller: carbonController };
    const store = new CarbonStrategyStore({
      readContract: async () => [{
        feePpm: 4000,
        strategies: [{
          id: 12n,
          owner: token0,
          tokens: [token0, token1],
          orders: [order(1_000n), order(2_000n)],
        }],
      }],
    }, [carbonPair]);
    let onLogs: ((logs: any[]) => void | Promise<void>) | undefined;
    const client = {
      watchContractEvent: async (options: { onLogs: typeof onLogs }) => {
        onLogs = options.onLogs;
        return () => {};
      },
    };
    const monitor = new EventMonitor({ client }, [new CarbonEventAdapter(store)]);

    await monitor.startBuffering();
    await onLogs?.([{
      address: carbonController,
      blockNumber: 2n,
      transactionIndex: 0,
      logIndex: 1,
      eventName: "StrategyUpdated",
      args: {
        id: 12n,
        token0,
        token1,
        order0: order(1_000n),
        order1: order(2_000n),
      },
    }]);

    expect(store.stats().strategyCount).toBe(0);
    await monitor.activate();
    expect(store.stats()).toEqual({ strategyCount: 1, pairCount: 1 });
    await monitor.stop();
  });

  test("updates strategy state from StrategyUpdated without runtime refetch", async () => {
    const client = {
      readContract: async () => {
        throw new Error("unexpected runtime Carbon refetch");
      },
    };
    let notified = 0;
    let changedPoolKeys: readonly string[] = [];
    let strategies: readonly unknown[] = [];
    const store = new CarbonStrategyStore(client, [pair], (nextStrategies, keys) => {
      notified++;
      strategies = nextStrategies;
      changedPoolKeys = keys;
    });

    await store.handleEvents(controller, [{
      eventName: "StrategyUpdated",
      args: {
        id: 12n,
        token0,
        token1,
        order0: order(1_000n),
        order1: order(2_000n),
      },
    }]);

    expect(store.stats()).toEqual({ strategyCount: 1, pairCount: 1 });
    expect(strategies[0]).toMatchObject({
      id: 12n,
      feePpm: 4000,
      orders: [order(1_000n), order(2_000n)],
    });
    expect(notified).toBe(1);
    expect(changedPoolKeys).toEqual([
      `carbon:${controller.toLowerCase()}:12`,
      `carbon-group:${controller.toLowerCase()}:${token0.toLowerCase()}:${token1.toLowerCase()}`,
      `carbon-group:${controller.toLowerCase()}:${token1.toLowerCase()}:${token0.toLowerCase()}`,
    ]);
  });
});

function order(y: bigint) {
  return {
    y,
    z: y,
    A: 0n,
    B: 1n,
  };
}
