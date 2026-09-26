import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, type Address } from "viem";
import { ARBITRAGE_SEARCH_POLICY, CONTRACTS, CONFIGURED_TOKENS } from "../src/constants";
import { EventMonitor } from "../src/runtime/event-monitor";
import { MarketGraph } from "../src/market-graph/market-graph";
import { V2_SYNC_EVENT_ABI } from "../src/protocols/v2/events";
import { V2EventAdapter } from "../src/protocols/v2/runtime";
import { V3EventAdapter } from "../src/protocols/v3/runtime";
import { V3Store } from "../src/protocols/v3/store";
import { pool, policy, v3Fixture, liquidityLog, swapLog, factory } from "./helpers/v3-fixture";

import { type ProtocolEventAdapter } from '../src/runtime/protocol-event-adapter';

const [token0, token1] = CONFIGURED_TOKENS.map(token => token.address);
describe("Market event ingestion", () => {
  test('V2 ingestion continues updating revisions while an earlier search is running', async () => {
    const graph = new MarketGraph(ARBITRAGE_SEARCH_POLICY);
    const pairAddress = '0x0000000000000000000000000000000000000a22' as Address;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const adapter = new V2EventAdapter({} as any, graph, [{ pairAddress, token0, token1, fee: 30, factory: '',
      variant: 'uniswap-v2', scale0: 1n, scale1: 1n }], async () => held);
    const first = adapter.apply([syncLog(pairAddress, 0, 100n, 100n, 2n)]);
    const versions = graph.marketVersions([pairAddress]);
    const second = adapter.apply([syncLog(pairAddress, 1, 200n, 201n, 2n)]);
    expect(graph.getAllPairs()[0].reserve0).toBe(200n);
    expect(graph.matchesVersions(versions)).toBe(false);
    const empty = adapter.apply([syncLog(pairAddress, 2, 0n, 0n, 2n)]);
    expect(graph.getAllPairs()[0].reserve0).toBe(0n);
    release();
    await Promise.all([first, second, empty]);
  });
  test("uses one feed for startup buffering and rejects stale live logs", async () => {
    const graph = new MarketGraph(ARBITRAGE_SEARCH_POLICY, []);
    const pairAddress = "0x0000000000000000000000000000000000000a22" as Address;
    const feed = fakeEventClient([[200n, 201n, BigInt(Math.floor(Date.now() / 1000))]]);
    const monitor = new EventMonitor({ client: feed.client }, [
      new V2EventAdapter(feed.client, graph, [{
        pairAddress, token0, token1, fee: 30, factory: '',
        variant: 'uniswap-v2', scale0: 1n, scale1: 1n,
      }], async () => {}),
    ]);

    await monitor.startBuffering();
    await feed.emit([syncLog(pairAddress, 1, 200n, 201n, 2n)]);
    expect(graph.getAllPairs()).toHaveLength(0);

    await monitor.activate();
    expect(graph.getAllPairs()[0]).toMatchObject({ reserve0: 200n, reserve1: 201n });

    await feed.emit([syncLog(pairAddress, 9, 100n, 101n, 1n)]);
    expect(graph.getAllPairs()[0]).toMatchObject({ reserve0: 200n, reserve1: 201n });

    await feed.emit([syncLog(pairAddress, 0, 300n, 301n, 3n)]);
    expect(graph.getAllPairs()[0]).toMatchObject({ reserve0: 300n, reserve1: 301n });
    await monitor.stop();
  });

  test("keeps the latest V2 Sync by chain log order", async () => {
    const graph = new MarketGraph(
      ARBITRAGE_SEARCH_POLICY,
      []
    );
    const pairAddress = "0x0000000000000000000000000000000000000a22" as Address;
    const feed = fakeEventClient();
    const monitor = new EventMonitor({ client: feed.client }, [
      new V2EventAdapter(feed.client, graph, [{
        pairAddress,
        token0,
        token1,
        fee: 30,
        factory: '',
        variant: 'uniswap-v2',
        scale0: 1n,
        scale1: 1n,
      }], async () => {}),
    ]);
    await monitor.start();

    await feed.emit([
      syncLog(pairAddress, 2, 200n, 201n),
      syncLog(pairAddress, 1, 100n, 101n),
    ]);

    expect(graph.getAllPairs()[0]).toMatchObject({
      pairAddress,
      reserve0: 200n,
      reserve1: 201n,
    });
    await monitor.stop();
  });

  test("rejects logs older than the hydration floor", async () => {
    const graph = new MarketGraph(ARBITRAGE_SEARCH_POLICY, []);
    const pairAddress = "0x0000000000000000000000000000000000000a22" as Address;
    const feed = fakeEventClient();
    graph.addPair({
      pairAddress, token0, token1, reserve0: 200n, reserve1: 201n, fee: 30,
      variant: "uniswap-v2", scale0: 1n, scale1: 1n,
    });
    const monitor = new EventMonitor({ client: feed.client }, [
      new V2EventAdapter(feed.client, graph, [{
        pairAddress, token0, token1, fee: 30, factory: "",
        variant: "uniswap-v2", scale0: 1n, scale1: 1n,
      }], async () => {}),
    ]);

    await monitor.startBuffering();
    await monitor.activate(2n);
    await feed.emit([syncLog(pairAddress, 0, 100n, 101n, 1n)]);
    expect(graph.getAllPairs()[0]).toMatchObject({ reserve0: 200n, reserve1: 201n });

    await feed.emit([syncLog(pairAddress, 0, 300n, 301n, 3n)]);
    expect(graph.getAllPairs()[0]).toMatchObject({ reserve0: 300n, reserve1: 301n });
    await monitor.stop();
  });

  test("reconciles selected markets and versions them at the current head", async () => {
    const graph = new MarketGraph(ARBITRAGE_SEARCH_POLICY, []);
    const pairAddress = "0x0000000000000000000000000000000000000a22" as Address;
    const feed = fakeEventClient([[300n, 301n, 1n]], 10n);
    graph.addPair({
      pairAddress, token0, token1, reserve0: 100n, reserve1: 101n, fee: 30,
      variant: "uniswap-v2", scale0: 1n, scale1: 1n,
    });
    const monitor = new EventMonitor({ client: feed.client }, [
      new V2EventAdapter(feed.client, graph, [{
        pairAddress, token0, token1, fee: 30, factory: "",
        variant: "uniswap-v2", scale0: 1n, scale1: 1n,
      }], async () => {}),
    ]);

    await monitor.start();
    await monitor.reconcileMarkets([pairAddress]);
    expect(graph.getAllPairs()[0]).toMatchObject({ reserve0: 300n, reserve1: 301n });

    await feed.emit([syncLog(pairAddress, 0, 200n, 201n, 10n)]);
    expect(graph.getAllPairs()[0]).toMatchObject({ reserve0: 300n, reserve1: 301n });
    await monitor.stop();
  });

  test("applies mixed V3 events without RPC or persistence and ignores duplicates", async () => {
    const previous = CONTRACTS.flashQuery;
    (CONTRACTS as any).flashQuery = factory;
    const selected = pool();
    const feed = v3Fixture([selected]);
    const store = new V3Store(':memory:');
    const graph = new MarketGraph(ARBITRAGE_SEARCH_POLICY, []);
    let scans = 0;
    const adapter = new V3EventAdapter(feed.client, graph, [selected], async () => { scans++; }, store, policy);
    const monitor = new EventMonitor({ client: feed.client }, [adapter]);
    try {
      await adapter.hydrate(10n);
      await monitor.start();
      feed.head = 11n;
      feed.liquidity = 1600n;
      feed.ticks.set(selected.address, [
        { index: -selected.tickSpacing, liquidityGross: 1600n, liquidityNet: 1600n },
        { index: selected.tickSpacing, liquidityGross: 1600n, liquidityNet: -1600n },
      ]);
      const before = feed.calls.length;
      feed.logs.push(liquidityLog(selected, 'Mint', 11n, -selected.tickSpacing, selected.tickSpacing, 600n), swapLog(selected, 11n, false, 1600n));
      await feed.callbacks[0]([...feed.logs].reverse());
      expect(graph.getV3Pools()[0].state?.liquidity).toBe(1600n);
      expect(graph.getV3InitializedTicks(selected.address)[0].liquidityGross).toBe(1600n);
      const reads = feed.calls.filter(call => call.functionName === 'getV3Ticks').length;
      await feed.callbacks[0](feed.logs);
      expect(feed.calls.filter(call => call.functionName === 'getV3Ticks')).toHaveLength(reads);
      expect(scans).toBe(1);
      expect(feed.calls.length).toBe(before);
      expect(store.snapshot(selected.address)?.blockNumber).toBe(10n);
    } finally {
      await monitor.stop();
      store.close();
      (CONTRACTS as any).flashQuery = previous;
    }
  });

  test("startup catch-up removes liquidity burned while the bot was offline", async () => {
    const previous = CONTRACTS.flashQuery;
    (CONTRACTS as any).flashQuery = factory;
    const selected = pool();
    const feed = v3Fixture([selected]);
    const store = new V3Store(':memory:');
    const graph = new MarketGraph(ARBITRAGE_SEARCH_POLICY, []);
    const adapter = new V3EventAdapter(feed.client, graph, [selected], async () => {}, store, policy);
    const monitor = new EventMonitor({ client: feed.client }, [adapter]);
    try {
      await monitor.startBuffering();
      await adapter.hydrate(10n);
      feed.head = 11n;
      feed.liquidity = 0n;
      feed.ticks.set(selected.address, []);
      feed.logs.push(liquidityLog(selected, 'Burn', 11n));
      await feed.callbacks[0](feed.logs);
      await monitor.activate(10n);
      expect(graph.getV3Pools()[0].state?.liquidity).toBe(0n);
      expect(graph.getV3InitializedTicks(selected.address)).toEqual([]);
      expect(store.snapshot(selected.address)?.blockNumber).toBe(11n);
    } finally {
      await monitor.stop();
      store.close();
      (CONTRACTS as any).flashQuery = previous;
    }
  });
});

function fakeEventClient(readResult?: unknown, blockNumber = 1n): { client: any; emit(logs: any[]): Promise<void> } {
  let onLogs: ((logs: any[]) => void | Promise<void>) | undefined;
  return {
    client: {
      watchContractEvent: async (options: { onLogs: typeof onLogs }) => {
        onLogs = options.onLogs;
        return () => {};
      },
      readContract: async () => readResult,
      getBlockNumber: async () => blockNumber,
    },
    async emit(logs) {
      if (!onLogs) throw new Error('event monitor is not started');
      await onLogs(logs);
    },
  };
}

function syncLog(
  pairAddress: Address,
  logIndex: number,
  reserve0: bigint,
  reserve1: bigint,
  blockNumber = 1n
): any {
  return {
    address: pairAddress,
    blockNumber,
    transactionIndex: 0,
    logIndex,
    topics: encodeEventTopics({
      abi: [V2_SYNC_EVENT_ABI[1]],
      eventName: "Sync",
    }),
    data: encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256" },
      ],
      [reserve0, reserve1]
    ),
  };
}

test('feed errors pause candidate acceptance immediately and shutdown cancels delayed reconnect', async () => {
  let error!: (error: Error) => void | Promise<void>;
  let watches = 0;
  const ready: boolean[] = [];
  const adapter: ProtocolEventAdapter = { id: 'test', addresses: () => [], owns: () => false,
    bufferKey: () => null, reconcile: async () => {}, reconcileAddresses: async () => {}, apply: async () => {},
    watch: async (_client, _logs, onError) => { watches++; error = onError; return []; } };
  const monitor = new EventMonitor({ client: {} }, [adapter], value => { ready.push(value); });
  await monitor.startBuffering();
  await monitor.activate();
  expect(ready.at(-1)).toBe(true);
  const recovery = error(new Error('provider rate limit'));
  expect(ready.at(-1)).toBe(false);
  await monitor.stop();
  await recovery;
  expect(watches).toBe(1);
  expect(ready.at(-1)).toBe(false);
}, 5_000);

test('recovery during initial subscription does not activate trading before hydration', async () => {
  let watches = 0;
  const ready: boolean[] = [];
  const adapter: ProtocolEventAdapter = { id: 'test', addresses: () => [], owns: () => false,
    bufferKey: () => null, reconcile: async () => {}, reconcileAddresses: async () => {}, apply: async () => {},
    watch: async () => { if (++watches === 1) throw new Error('websocket unavailable'); return []; } };
  const monitor = new EventMonitor({ client: { getBlockNumber: async () => 1n }, wsClient: {} }, [adapter], value => { ready.push(value); });
  try {
    await monitor.startBuffering();
    expect(watches).toBe(2);
    expect(ready.includes(true)).toBe(false);
    await monitor.activate(1n);
    expect(ready.at(-1)).toBe(true);
  } finally { await monitor.stop(); }
}, 5_000);
