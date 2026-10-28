import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Address } from 'viem';
import { estimateTransfer, receivedAfterTransfer, type TokenTransferProfile } from '../src/protocols/v2/transfer-fees';
import { quoteV2ExactInput, swapV2 } from '../src/protocols/v2/quote';
import { TransferProfileStore } from '../src/protocols/v2/transfer-store';
import { profileV2Transfers } from '../src/protocols/v2/transfer-probes';
import { MarketGraph } from '../src/market-graph/market-graph';
import { quoteSplitStages } from '../src/opportunities/split-routing';
import { V2_LIVE_POLICY } from '../src/protocols/v2/config';
import { ARBITRAGE_SEARCH_POLICY, CONTRACTS, EXECUTION_POLICY } from '../src/constants';
import { type PairInfo } from '../src/protocols/v2/types';
import { OpportunityEngine } from '../src/opportunities/opportunity-engine';
import { createExecutionPlan } from '../src/execution/execution-planner';
import { V2EventAdapter } from '../src/protocols/v2/runtime';
import { logger } from '../src/reporting/logger';

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const a = addr(1), b = addr(2), executor = addr(3), origin = addr(4);
function estimate(fee = 0) {
  return estimateTransfer([10000n, 10n ** 12n].map(requested => ({ requested, debited: requested, credited: requested * BigInt(10000 - fee) / 10000n })));
}
function profile(token: Address, pool: Address, buy = 0, sell = 0): TokenTransferProfile {
  return { token, pool, executor, origin, recipient: origin, blockNumber: 123n, observedAt: Date.now(), validUntil: Date.now() + 3600000,
    buy: estimate(buy), sell: estimate(sell), transfer: estimate() };
}
function pair(pool: Address, buy = 0, sell = 0): PairInfo {
  return { pairAddress: pool, token0: a, token1: b, reserve0: 100_000_000n, reserve1: 200_000_000n,
    fee: 30, variant: 'uniswap-v2', scale0: 10n ** 18n, scale1: 10n ** 18n,
    transferProfiles: { token0: profile(a, pool), token1: profile(b, pool, buy, sell) } };
}

describe('transfer estimates', () => {
  test('keeps unknown distinct from observed zero', () => {
    expect(estimateTransfer([]).status).toBe('unknown');
    expect(estimate().status).toBe('measured');
    expect(estimate().feeBps).toBe(0);
    expect(estimate(2200).feeBps).toBe(2200);
  });
  test('rejects sender fees, capped credit, zero credit and inconsistent rates', () => {
    for (const samples of [
      [{ requested: 10000n, debited: 10001n, credited: 10000n }, { requested: 20000n, debited: 20001n, credited: 20000n }],
      [{ requested: 10000n, debited: 10000n, credited: 1n }, { requested: 20000n, debited: 20000n, credited: 1n }],
      [{ requested: 10000n, debited: 10000n, credited: 0n }, { requested: 20000n, debited: 20000n, credited: 0n }],
      [{ requested: 10000n, debited: 10000n, credited: 9000n }, { requested: 20000n, debited: 20000n, credited: 10000n }],
    ]) {
      const fitted = estimateTransfer(samples);
      expect(fitted.status === 'unsupported' || fitted.feeBps === 10000).toBe(true);
      expect(receivedAfterTransfer(10000n, fitted, Date.now() + 10000)).toBe(0n);
    }
  });
  test('does not extrapolate beyond range or expiry', () => {
    const tax = estimate(2200);
    expect(receivedAfterTransfer(10000n, tax, 200, 100)).toBe(7800n);
    expect(receivedAfterTransfer(9999n, tax, 200, 100)).toBe(0n);
    expect(receivedAfterTransfer(tax.maxAmount + 1n, tax, 200, 100)).toBe(0n);
    expect(receivedAfterTransfer(10000n, tax, 200, 200)).toBe(0n);
  });
  test('quotes sell deduction before AMM fee and buy deduction afterwards', () => {
    const input = profile(a, addr(5), 0, 1000), output = profile(b, addr(5), 2200);
    const quote = quoteV2ExactInput(100000n, { variant: 'uniswap-v2', reserveIn: 100000000n, reserveOut: 100000000n,
      scaleIn: 1n, scaleOut: 1n, fee: 30, transferFees: { input, output } });
    expect(quote).toBe(swapV2(90000n, 100000000n, 100000000n, 30) * 7800n / 10000n);
  });
});

describe('graph integration', () => {
  test('linear and split use the same custody-transfer estimates', () => {
    const graph = new MarketGraph();
    graph.addPair(pair(addr(10), 2200)); graph.addPair(pair(addr(11), 0, 1000));
    const edges = graph.takeChanges(true).pairs;
    expect(edges[0].transferProfiles?.token1.buy.feeBps).toBe(2200);
    const first = graph.splitEdgeIndexes(a, b, 10, () => true);
    const second = graph.splitEdgeIndexes(b, a, 10, () => true);
    const e1 = first.find(e => graph.edgeAt(e)?.poolAddress === addr(10))!;
    const e2 = second.find(e => graph.edgeAt(e)?.poolAddress === addr(11))!;
    const route = { path: [a, b, a], pools: [addr(10), addr(11)], edgeIds: [graph.edgeAt(e1)!.id, graph.edgeAt(e2)!.id], edgeIndexes: [e1, e2], protocols: ['v2', 'v2'] as const };
    const firstOut = graph.quoteEdgeAt(e1, 100000n).amountOut;
    const split = quoteSplitStages(graph, [a, b, a], [[{ edgeIndex: e1, amountIn: 100000n }], [{ edgeIndex: e2, amountIn: firstOut }]], 0);
    expect(split?.amountOut).toBe(graph.quote({ ...route, protocols: [...route.protocols] }, 100000n).amountOut);
    expect(split?.stages[0].branches[0].data).toBe('0x02');
    const worker = new MarketGraph(); worker.applyChanges(graph.takeChanges(true));
    expect(worker.quote({ ...route, protocols: [...route.protocols] }, 100000n)).toEqual(graph.quote({ ...route, protocols: [...route.protocols] }, 100000n));
  });
  test('reserve updates preserve profiles, refresh invalidates versions, expiry rejects results', () => {
    const graph = new MarketGraph(), p = pair(addr(10)); graph.addPair(p);
    const before = graph.marketVersions([p.pairAddress]);
    graph.addPair({ ...p, reserve0: 999999n, transferProfiles: undefined });
    expect(graph.getAllPairs()[0].transferProfiles).toBe(p.transferProfiles!);
    expect(graph.matchesVersions(before)).toBe(false);
    const current = graph.marketVersions([p.pairAddress]);
    p.transferProfiles!.token0.validUntil = Date.now() - 1;
    expect(graph.matchesVersions(current)).toBe(false);
  });
  test('worker deltas carry refreshed estimates but not samples or repeated profiles', () => {
    const graph = new MarketGraph(), worker = new MarketGraph(), p = pair(addr(10), 2200);
    graph.addPair(p);
    const first = graph.takeChanges(true);
    expect(first.pairs[0].transferProfiles?.token1.buy.samples).toEqual([]);
    worker.applyChanges(first);
    graph.updateReserves([{ pairAddress: p.pairAddress, reserve0: 99999999n, reserve1: 200000000n }]);
    const delta = graph.takeChanges();
    expect(delta.pairs[0].transferProfiles).toBeUndefined();
    worker.applyChanges(delta);
    expect(worker.getAllPairs()[0].transferProfiles?.token1.buy.feeBps).toBe(2200);
    graph.addPair({ ...graph.getAllPairs()[0], transferProfiles: pair(addr(10), 1000).transferProfiles });
    const refresh = graph.takeChanges(); worker.applyChanges(refresh);
    expect(worker.getAllPairs()[0].transferProfiles?.token1.buy.feeBps).toBe(1000);
    expect(worker.getAllPairs()[0].reserve0).toBe(99999999n);
    expect(worker.matchesVersions(refresh.versions)).toBe(true);
  });
  test('flash funding rejects taxed borrowed assets', () => {
    const graph = new MarketGraph(); graph.addPair(pair(addr(10), 2200));
    expect(graph.findBestFlashPoolForToken(b, 100000n)).toBeNull();
    expect(graph.findBestFlashPoolForToken(a, 100000n)?.poolAddress).toBe(addr(10));
  });
  test('search sizes a profitable taxed route and produces custody execution data', () => {
    const engine = new OpportunityEngine({ ...ARBITRAGE_SEARCH_POLICY, allowedProtocols: ['v2'], maxRouteEdges: 2 }, [],
      [{ name: 'A', address: a, decimals: 18, liquidityAmount: 1n, minProfitNative: 1n }]);
    engine.graph.addPair(pair(addr(10), 2200));
    engine.graph.addPair({ ...pair(addr(11), 0, 1000), reserve0: 200000000n, reserve1: 100000000n });
    engine.graph.addPair({ ...pair(addr(12)), reserve0: 1000000000n, reserve1: 1000000000n });
    const result = engine.findOpportunities({ startTokens: [a] }).find(r => r.pairs.includes(addr(10)) && r.pairs.includes(addr(11)));
    expect(result).toBeDefined(); expect(result!.profit).toBeGreaterThan(0n);
    expect(result!.routeData).toEqual(['0x02', '0x02']);
    const plan = createExecutionPlan(engine.graph, result!);
    expect(plan?.kind).toBe('flash');
    if (plan?.kind === 'flash') expect(plan.params.data).toEqual(['0x02', '0x02']);
  });
  test('route flash keeps tax custody and falls back when the first input is taxed', () => {
    const previous = { address: CONTRACTS.arbitrage, enabled: EXECUTION_POLICY.routeSwapFunding };
    Object.assign(CONTRACTS, { arbitrage: executor });
    Object.assign(EXECUTION_POLICY, { routeSwapFunding: true });
    try {
      const makeEngine = (firstSellTax: number) => {
        const engine = new OpportunityEngine({ ...ARBITRAGE_SEARCH_POLICY, allowedProtocols: ['v2'], maxRouteEdges: 2 }, [],
          [{ name: 'A', address: a, decimals: 18, liquidityAmount: 1n, minProfitNative: 1n }]);
        const first = pair(addr(10), 2200);
        first.transferProfiles!.token0 = profile(a, addr(10), 0, firstSellTax);
        engine.graph.addPair(first);
        engine.graph.addPair({ ...pair(addr(11), 0, 1000), reserve0: 200000000n, reserve1: 100000000n });
        engine.graph.addPair({ ...pair(addr(12)), reserve0: 1000000000n, reserve1: 1000000000n });
        return engine;
      };
      const route = (engine: OpportunityEngine) => engine.findOpportunities({ startTokens: [a] })
        .find(result => result.pairs[0] === addr(10) && result.pairs[1] === addr(11));
      const direct = makeEngine(0);
      const first = route(direct);
      expect(first?.routeSwap).toBe(true);
      expect(createExecutionPlan(direct.graph, first!)?.kind).toBe('plan');

      const taxed = makeEngine(1000);
      const fallback = route(taxed);
      expect(fallback?.routeSwap).toBe(false);
      expect(createExecutionPlan(taxed.graph, fallback!)?.kind).toBe('flash');
    } finally {
      Object.assign(CONTRACTS, { arbitrage: previous.address });
      Object.assign(EXECUTION_POLICY, { routeSwapFunding: previous.enabled });
    }
  });
});

describe('profile storage and simulation', () => {
  const directories: string[] = [];
  const originalDB = process.env.MARKET_DB_PATH;
  const originalEnabled = V2_LIVE_POLICY.transferFees;
  const originalArb = CONTRACTS.arbitrage, originalQuery = CONTRACTS.flashQuery;
  const originalProtocols = ARBITRAGE_SEARCH_POLICY.allowedProtocols;
  afterEach(() => {
    Object.assign(V2_LIVE_POLICY, { transferFees: originalEnabled });
    Object.assign(CONTRACTS, { arbitrage: originalArb, flashQuery: originalQuery });
    ARBITRAGE_SEARCH_POLICY.allowedProtocols = originalProtocols;
    if (originalDB === undefined) delete process.env.MARKET_DB_PATH; else process.env.MARKET_DB_PATH = originalDB;
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  function dbPath() { const directory = mkdtempSync(join(tmpdir(), 'arb-tax-test-')); directories.push(directory); return join(directory, 'markets.sqlite'); }
  test('persists bigint observations and separates executor, origin and pool', () => {
    const path = dbPath(), p = profile(b, addr(10), 2200), store = new TransferProfileStore(path);
    store.save(p); store.close();
    const reopened = new TransferProfileStore(path);
    try {
      expect(reopened.get(executor, origin, addr(10), b)).toEqual(p);
      expect(reopened.get(addr(99), origin, addr(10), b)).toBeUndefined();
      expect(reopened.get(executor, addr(99), addr(10), b)).toBeUndefined();
      expect(reopened.get(executor, origin, addr(11), b)).toBeUndefined();
      reopened.save({ ...p, observedAt: p.observedAt - 1, buy: estimate(5000) });
      expect(reopened.get(executor, origin, addr(10), b)?.buy.feeBps).toBe(2200);
    } finally { reopened.close(); }
  });
  test('uses unsigned eth_call batches at one block and reuses current profiles', async () => {
    process.env.MARKET_DB_PATH = dbPath();
    Object.assign(V2_LIVE_POLICY, { transferFees: true });
    Object.assign(CONTRACTS, { arbitrage: executor, flashQuery: addr(50) });
    ARBITRAGE_SEARCH_POLICY.allowedProtocols = ['v2'];
    let calls = 0;
    const client = {
      readContract: async () => origin, getBlockNumber: async () => 123n,
      getBlock: async () => ({ hash: addr(123) }),
      simulateContract: async (request: any) => {
        calls++; expect(request.account).toBe(origin); expect(request.blockNumber).toBe(123n);
        expect(request.functionName).toBe('probeV2Transfers');
        return { result: request.args[1].map((r: any) => {
          const buy = r.amount, half = buy / 2n, rest = buy - half;
          return { measured: true, error: '0x00000000', amounts: [buy, buy, buy, rest, rest, rest, half, half, half] };
        }) };
      },
    };
    const p = { ...pair(addr(10)), reserve0: 10n ** 18n, reserve1: 10n ** 18n, transferProfiles: undefined };
    const result = await profileV2Transfers(client, [p]);
    expect(result[0].transferProfiles?.token0.buy.status).toBe('measured');
    const firstCalls = calls;
    await profileV2Transfers(client, [p]); expect(calls).toBe(firstCalls);
  });
});

test('V2 profile refresh wakes for expiry or a newly hydrated unprofiled pair', async () => {
  const errorLog = spyOn(logger, 'error').mockImplementation(() => {});
  try {
    for (const missing of [false, true]) {
      const graph = new MarketGraph();
      let calls = 0;
      let entered!: () => void;
      const fired = new Promise<void>(resolve => { entered = resolve; });
      const client = {
        async getBlockNumber() { calls++; entered(); throw new Error('probe unavailable'); },
        async simulateContract() { return { result: [] }; },
      };
      const adapter = new V2EventAdapter(client as any, graph, [], async () => {});
      const stops = await adapter.watch(client as any, async () => {}, async () => {});
      try {
        const p = pair(addr(missing ? 12 : 13));
        if (missing) p.transferProfiles = undefined;
        else {
          p.transferProfiles!.token0.validUntil = Date.now() + 30;
          p.transferProfiles!.token1.validUntil = Date.now() + 30;
        }
        graph.addPair(p);
        adapter.rescheduleTransferRefresh();
        await Promise.race([fired, Bun.sleep(1000).then(() => { throw new Error('profile refresh did not wake'); })]);
        expect(calls).toBe(1);
      } finally {
        for (const stop of stops) await stop();
      }
    }
  } finally { errorLog.mockRestore(); }
});
