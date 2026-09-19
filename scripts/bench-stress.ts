import { TOKENS } from '../src/constants';
import { type PairInfo, type ReserveUpdate } from '../src/protocols/v2/types';
import { type V3PoolConfig } from '../src/protocols/v3/types';
import { type ArbitrageSearchPolicy } from '../src/market-graph/types';
import { OpportunityEngine } from '../src/opportunities/opportunity-engine';
import { Q96 } from '../src/protocols/v3/quote';
import { tokenAmount } from '../src/values';
import { LatestUpdateScheduler } from '../src/runtime/event-scheduler';
import { type Address } from 'viem';
import { WorkerSearch } from '../src/opportunities/worker-search';
import { latency } from '../src/runtime/latency';

const [tokenA, tokenB, tokenC] = TOKENS.map(({ address }) => address);

const policy: ArbitrageSearchPolicy = {
  topTokens: 1,
  allowedProtocols: ['v2', 'v3'],
  allowProtocolMixing: true,
  maxRouteEdges: 4,
  beamWidth: 8,
  optimizationIterations: 32,
  maxInputReserveFraction: 100n,
  maxOpportunities: 8,
};

function tokenAddress(id: number): Address {
  return `0x${(30_000_000 + id).toString(16).padStart(40, '0')}` as Address;
}

function pairAddress(id: number): Address {
  return `0x${(40_000_000 + id).toString(16).padStart(40, '0')}` as Address;
}

function poolAddress(id: number): Address {
  return `0x${(50_000_000 + id).toString(16).padStart(40, '0')}` as Address;
}

function pair(id: number, token0: Address, token1: Address, reserve0: bigint, reserve1: bigint): PairInfo {
  return { pairAddress: pairAddress(id), token0, token1, reserve0, reserve1, fee: 30, variant: 'uniswap-v2', scale0: 1n, scale1: 1n };
}

function pool(id: number, token0: Address, token1: Address): V3PoolConfig {
  return {
    name: `bench-${id}`,
    address: poolAddress(id),
    token0,
    token1,
    fee: 500,
    tickSpacing: 10,
    enabled: true,
  };
}

function addLivePool(engine: OpportunityEngine, config: V3PoolConfig, sqrtPriceX96 = Q96): void {
  engine.graph.addV3Pool(config);
  engine.graph.updateV3PoolStates([{
    poolAddress: config.address,
    sqrtPriceX96,
    liquidity: 10n ** 24n,
    tick: 0,
  }]);
}

function createUnifiedMarket(): { engine: OpportunityEngine; changedPair: PairInfo } {
  const engine = new OpportunityEngine(policy, []);

  for (let i = 0; i < 15_000; i++) {
    engine.graph.addPair(pair(10_000 + i, tokenA, tokenAddress(i), tokenAmount('1000000'), tokenAmount('999000')));
  }

  for (let i = 0; i < 5_000; i++) {
    addLivePool(engine, pool(20_000 + i, tokenA, tokenAddress(15_000 + i)));
  }

  const changedPair = pair(1, tokenA, tokenB, tokenAmount('1000'), tokenAmount('2200'));
  engine.graph.addPair(changedPair);
  engine.graph.addPair(pair(2, tokenC, tokenA, tokenAmount('1000'), tokenAmount('2200')));
  addLivePool(engine, pool(1, tokenB, tokenC), Q96 * 2n);
  return { engine, changedPair };
}

function createV2Market(): { engine: OpportunityEngine; changedPair: PairInfo } {
  const engine = new OpportunityEngine(policy, []);

  for (let i = 0; i < 25_000; i++) {
    engine.graph.addPair(pair(10_000 + i, tokenA, tokenAddress(i), tokenAmount('1000000'), tokenAmount('999000')));
  }

  const changedPair = pair(1, tokenA, tokenB, tokenAmount('1000'), tokenAmount('1100'));
  engine.graph.addPair(changedPair);
  engine.graph.addPair(pair(2, tokenB, tokenC, tokenAmount('1000'), tokenAmount('2200')));
  engine.graph.addPair(pair(3, tokenC, tokenA, tokenAmount('1000'), tokenAmount('2200')));
  return { engine, changedPair };
}

function measure(label: string, run: () => void): number {
  const start = performance.now();
  run();
  const elapsed = performance.now() - start;
  console.log(`${label}: ${elapsed.toFixed(2)}ms`);
  return elapsed;
}

async function measureAsync(label: string, run: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await run();
  const elapsed = performance.now() - start;
  console.log(`${label}: ${elapsed.toFixed(2)}ms`);
  return elapsed;
}

async function main(): Promise<void> {
  const unified = measure('unified build', () => createUnifiedMarket());
  const { engine: unifiedEngine, changedPair: unifiedChangedPair } = createUnifiedMarket();
  unifiedEngine.findOpportunities({ startTokens: [tokenA] });
  const unifiedSearch = measure('unified event-local search', () => {
    unifiedEngine.findOpportunities({ startTokens: [tokenA], changedPairs: [unifiedChangedPair.pairAddress] });
  });

  const v2 = measure('v2 build', () => createV2Market());
  const { engine: v2Engine, changedPair: v2ChangedPair } = createV2Market();
  v2Engine.findOpportunities({ startTokens: [tokenA] });
  const v2Search = measure('v2 event-local search', () => {
    v2Engine.findOpportunities({ startTokens: [tokenA], changedPairs: [v2ChangedPair.pairAddress] });
  });

  const scheduler = new LatestUpdateScheduler<ReserveUpdate>(
    async () => {},
    update => update.pairAddress.toLowerCase()
  );
  const burst = Array.from({ length: 50_000 }, (_, i) => ({
    pairAddress: pairAddress(i % 100),
    reserve0: BigInt(i),
    reserve1: BigInt(i + 1),
  }));
  const schedulerRun = await measureAsync('scheduler burst', () => scheduler.submit(burst));

  const worker = new WorkerSearch(v2Engine.graph, policy);
  let heartbeatTicks = 0;
  let largestHeartbeatGapMs = 0;
  try {
    await worker.search({ startTokens: [tokenA] }); // cold transfer is reported separately in telemetry
    let previous = performance.now();
    const heartbeat = setInterval(() => {
      const now = performance.now();
      largestHeartbeatGapMs = Math.max(largestHeartbeatGapMs, now - previous);
      previous = now;
      heartbeatTicks++;
    }, 1);
    try {
      for (let i = 0; i < 20; i++) {
        v2Engine.graph.updateReserves([{ pairAddress: v2ChangedPair.pairAddress, reserve0: v2ChangedPair.reserve0, reserve1: v2ChangedPair.reserve1 + 1n }]);
        await worker.search({ startTokens: [tokenA], changedPairs: [v2ChangedPair.pairAddress] });
      }
    } finally { clearInterval(heartbeat); }
  } finally { worker.stop(); }

  console.log(JSON.stringify({ unified, unifiedSearch, v2, v2Search, schedulerRun,
    worker: { heartbeatTicks, largestHeartbeatGapMs, metrics: latency.snapshot() } }, null, 2));
}

await main();
