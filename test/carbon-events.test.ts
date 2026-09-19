import { describe, expect, test } from "bun:test";
import { decodeFunctionResult, encodeFunctionData, encodeFunctionResult, type Address } from "viem";
import UniswapFlashQueryABI from '../src/ABI/UniswapFlashQuery.json';
import { CONTRACTS, TOKENS } from '../src/constants';
import { EventMonitor } from "../src/runtime/event-monitor";
import { CarbonStrategyStore } from "../src/protocols/carbon/runtime";
import { type CarbonPairMetadata, type CarbonUpdate } from "../src/protocols/carbon/types";
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
    const updates: CarbonUpdate[] = [];
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
    }, [pair], update => { updates.push(update); });
    try {
      await store.loadAll();
      expect(reads).toBe(1);
      expect(store.stats()).toEqual({ strategyCount: 1, pairCount: 1 });
      expect(updates[0]).toMatchObject({ kind: 'snapshot', strategies: [{ id: 12n }] });
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
    const store = new CarbonStrategyStore(client, [pair], (update, keys) => {
      notified++;
      expect(update.kind).toBe('delta');
      strategies = update.kind === 'delta' ? update.upserts : update.strategies;
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

  test('coalesces event batches and isolates the same ID on different controllers', async () => {
    const secondController = token1;
    const updates: CarbonUpdate[] = [];
    const store = new CarbonStrategyStore({ readContract: async () => { throw new Error('unexpected RPC'); } },
      [pair, { ...pair, controller: secondController }], update => { updates.push(update); });
    const event = (eventName: string, y = 1000n) => ({ eventName,
      args: { id: 12n, token0, token1, order0: order(y), order1: order(y) } });
    await store.handleEvents(controller, [event('StrategyCreated'), event('StrategyUpdated', 2000n)]);
    expect(updates[0]).toMatchObject({ kind: 'delta', removed: [], upserts: [{ id: 12n, orders: [order(2000n), order(2000n)] }] });
    await store.handleEvents(secondController, [event('StrategyCreated')]);
    expect(store.stats()).toEqual({ pairCount: 2, strategyCount: 2 });
    await store.handleEvents(controller, [event('StrategyUpdated'), event('StrategyDeleted')]);
    expect(updates[2]).toEqual({ kind: 'delta', upserts: [], removed: [{ controller, id: 12n }] });
    expect(store.stats()).toEqual({ pairCount: 1, strategyCount: 1 });
    await store.handleEvents(secondController, [event('StrategyUpdated', 0n)]);
    expect(store.stats()).toEqual({ pairCount: 0, strategyCount: 0 });
    expect(updates[3]).toEqual({ kind: 'delta', upserts: [], removed: [{ controller: secondController, id: 12n }] });
  });

  test('dropping below the liquidity filter emits a removal and recovery replaces the catalog', async () => {
    const selected = TOKENS.find(token => token.liquidityAmount > 1n)!;
    const selectedPair = { ...pair, token0: selected.address };
    const updates: CarbonUpdate[] = [];
    let reads = 0;
    const store = new CarbonStrategyStore({ readContract: async () => { reads++; return [{ strategies: [], feePpm: pair.feePpm }]; } },
      [selectedPair], update => { updates.push(update); });
    const event = (y: bigint) => ({ eventName: 'StrategyUpdated', args: {
      id: 12n, token0: selected.address, token1, order0: order(y), order1: order(0n),
    } });
    await store.handleEvents(controller, [event(selected.liquidityAmount)]);
    expect(store.stats().strategyCount).toBe(1);
    await store.handleEvents(controller, [event(1n)]);
    expect(updates[1]).toEqual({ kind: 'delta', upserts: [], removed: [{ controller, id: 12n }] });
    expect(store.stats().strategyCount).toBe(0);
    await store.handleEvents(controller, [event(selected.liquidityAmount)]);
    expect(reads).toBe(0);
    const previousAddress = CONTRACTS.flashQuery;
    Object.assign(CONTRACTS, { flashQuery: controller });
    try {
      await store.loadAll();
      expect(updates[3]).toEqual({ kind: 'snapshot', strategies: [] });
      expect(store.stats()).toEqual({ pairCount: 0, strategyCount: 0 });
      expect(reads).toBe(1);
    } finally { Object.assign(CONTRACTS, { flashQuery: previousAddress }); }
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
