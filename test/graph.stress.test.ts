import { expect, test } from 'bun:test';
import { CONFIGURED_TOKENS } from '../src/constants';
import { type Address } from 'viem';
import { OpportunityEngine } from '../src/opportunities/opportunity-engine';
import { Q96 } from '../src/protocols/v3/quote';
import { tokenAmount } from '../src/values';
import { address, v2Pair } from './helpers/markets';

const [a, b, c] = CONFIGURED_TOKENS.map(token => token.address);
const modes = [
  { name: 'V2', v2: Number(process.env.V2_STRESS_PAIRS ?? 25000), v3: 0,
    limitMs: Number(process.env.V2_STRESS_SEARCH_LIMIT_MS ?? 1000), fraction: 3n, opportunities: 10 },
  { name: 'V2/V3', v2: 15000, v3: 5000, limitMs: 1250, fraction: 100n, opportunities: 8 },
];
function market(mode: typeof modes[number]) {
  const engine = new OpportunityEngine({ topTokens: 1, allowedProtocols: ['v2', 'v3'],
    allowProtocolMixing: true, maxRouteEdges: 4, beamWidth: 8, optimizationIterations: 80,
    maxInputReserveFraction: mode.fraction, maxOpportunities: mode.opportunities }, []);
  function addV3(id: number, token0: Address, token1: Address, sqrtPriceX96: bigint, liquidity: bigint) {
    const pool = { name: `stress-${id}`, address: address(50000000 + id),
      token0, token1, fee: 500, tickSpacing: 10, enabled: true };
    engine.graph.addV3Pool(pool);
    engine.graph.updateV3PoolStates([{ poolAddress: pool.address, sqrtPriceX96, liquidity, tick: 0 }]);
    return pool.address;
  }
  for (let i = 0; i < mode.v2; i++) engine.graph.addPair(v2Pair(10000 + i,
    a, address(30000000 + i), tokenAmount('1000000'), tokenAmount('999000')));
  for (let i = 0; i < mode.v3; i++) addV3(20000 + i, a, address(30000000 + mode.v2 + i), Q96, 10n ** 18n);

  const changed = v2Pair(1, a, b, tokenAmount('1000'), tokenAmount(mode.v3 ? '2200' : '1100'));
  engine.graph.addPair(changed);
  engine.graph.addPair(v2Pair(3, c, a, tokenAmount('1000'), tokenAmount('2200')));
  const mixedPool = mode.v3 ? addV3(1, b, c, Q96 * 2n, 10n ** 24n) : undefined;
  if (!mode.v3) engine.graph.addPair(v2Pair(2, b, c, tokenAmount('1000'), tokenAmount('2200')));
  return { engine, changed, mixedPool };
}

for (const mode of modes) for (const update of [false, true]) {
  test(`${mode.name} stress: event-local ${update ? 'reserve update and scan' : 'scan'} stays bounded`, () => {
    const { engine, changed, mixedPool } = market(mode);
    const started = performance.now();
    if (update) engine.graph.updateReserves([{ pairAddress: changed.pairAddress,
      reserve0: tokenAmount('1000'), reserve1: tokenAmount(mode.v3 ? '2500' : '1200') }]);
    const quotes = engine.findOpportunities({ startTokens: [a], changedPairs: [changed.pairAddress] });
    const elapsed = performance.now() - started;
    expect(quotes.length).toBeGreaterThan(0);
    for (const quote of quotes) expect(quote.pairs).toContain(changed.pairAddress);
    if (mixedPool) {
      expect(new Set(quotes[0].protocols).size).toBeGreaterThan(1);
      expect(quotes[0].pairs).toContain(mixedPool);
    }
    expect(typeof quotes[0].profit).toBe('bigint');
    expect(typeof quotes[0].optimalInput).toBe('bigint');
    expect(elapsed).toBeLessThan(mode.limitMs);
  });
}
