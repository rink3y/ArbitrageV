import { type Address } from 'viem';
import { ARBITRAGE_SEARCH_POLICY } from '../src/constants';
import { MarketGraph } from '../src/market-graph/market-graph';
import { type CarbonStrategy } from '../src/protocols/carbon/types';

// Offline fixture: one changed strategy per batch, ten strategies per raw pair.
// Clone timing is a serialization proxy, not a worker or network round trip.
const address = (id: number): Address => `0x${id.toString(16).padStart(40, '0')}`;
const policy = { ...ARBITRAGE_SEARCH_POLICY, allowedProtocols: ['carbon'] as const };
const count = 10_000;
const strategies: CarbonStrategy[] = Array.from({ length: count }, (_, i) => ({
  id: BigInt(i), controller: address(1), owner: address(2), feePpm: 4000,
  token0: address(100 + Math.floor(i / 10) * 2), token1: address(101 + Math.floor(i / 10) * 2),
  orders: [0, 1].map(() => ({ y: 1000000n, z: 1000000n, A: 0n, B: (1n << 47n) | (2n << 48n) })) as CarbonStrategy['orders'],
}));
const full = { source: new MarketGraph(policy), worker: new MarketGraph(policy) };
const delta = { source: new MarketGraph(policy), worker: new MarketGraph(policy) };
for (const path of [full, delta]) {
  path.source.setCarbonStrategies(strategies);
  path.worker.applyChanges(structuredClone(path.source.takeChanges(true)));
}
const samples = { full: [] as number[][], delta: [] as number[][] };
const payloads: Record<string, { strategies: number; jsonBytes: number }> = {};
for (let i = 0; i < 70; i++) {
  const index = (i * 137) % count;
  strategies[index] = { ...strategies[index], orders: [strategies[index].orders[0], { ...strategies[index].orders[1], y: BigInt(900000 + i) }] };
  // Alternate measurement order; discard ten warm-up iterations.
  for (const name of (i % 2 ? ['delta', 'full'] : ['full', 'delta']) as Array<'full' | 'delta'>) {
    const path = name === 'full' ? full : delta;
    const start = performance.now();
    if (name === 'full') path.source.setCarbonStrategies(strategies);
    else path.source.updateCarbonStrategies({ upserts: [strategies[index]], removed: [] });
    const updated = performance.now();
    const changes = path.source.takeChanges();
    const drained = performance.now();
    const cloned = structuredClone(changes);
    const transferred = performance.now();
    path.worker.applyChanges(cloned);
    const applied = performance.now();
    if (i >= 10) samples[name].push([updated - start, drained - updated, transferred - drained, applied - transferred, applied - start]);
    if (i === 69) {
      payloads[name] = {
        strategies: changes.carbon?.kind === 'snapshot' ? changes.carbon.strategies.length : changes.carbon?.upserts.length ?? 0,
        jsonBytes: new TextEncoder().encode(JSON.stringify(changes, (_, value) => typeof value === 'bigint' ? value.toString() : value)).length,
      };
    }
  }
}
console.log(`Carbon: ${count} strategies / ${count / 10} pairs; one strategy changed per batch; 60 warmed samples.`);
for (const name of ['full', 'delta'] as const) {
  console.log(`${name}: ${payloads[name].strategies} strategies transferred; ${payloads[name].jsonBytes} JSON bytes (size proxy)`);
  for (const [column, label] of ['main update', 'patch extraction', 'structured clone', 'worker graph apply', 'total'].entries()) {
    const sorted = samples[name].map(row => row[column]).sort((a, b) => a - b);
    console.log(`  ${label}: median ${sorted[Math.floor(sorted.length / 2)].toFixed(3)} ms; p95 ${sorted[Math.ceil(sorted.length * .95) - 1].toFixed(3)} ms`);
  }
}
