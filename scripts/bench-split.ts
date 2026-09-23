import { ARBITRAGE_SEARCH_POLICY, TOKENS } from '../src/constants';
import { OpportunityEngine } from '../src/opportunities/opportunity-engine';
import { WorkerSearch } from '../src/opportunities/worker-search';
import { splitCostsFromConstants } from '../src/opportunities/split-costs';
import { applyV2SplitFill } from '../src/opportunities/split-replay';

const [a, b] = TOKENS.map(token => token.address);
const unit = 10n ** 18n;
const policy = { ...ARBITRAGE_SEARCH_POLICY, splitRouting: 'shadow' as const, maxRouteEdges: 3 };
const engine = new OpportunityEngine(policy);
for (const [id, x, y] of [[1, 10000n, 20000n], [2, 10000n, 20000n], [3, 20000n, 20000n], [4, 1000000n, 1000000n]] as const) {
  engine.graph.addPair({ pairAddress: `0x${id.toString(16).padStart(40, '0')}`, token0: a, token1: b,
    reserve0: x * unit, reserve1: y * unit, fee: 30, variant: 'uniswap-v2', scale0: 1n, scale1: 1n });
}
const snapshot = engine.graph.takeChanges(true);
const baseline = new OpportunityEngine({ ...policy, splitRouting: 'off' }); baseline.graph.applyChanges(snapshot);
const off = new WorkerSearch(baseline.graph, baseline.policy);
const shadow = new WorkerSearch(engine.graph, engine.policy);
const timings = { off: [] as number[], shadow: [] as number[] };
let splitObservations = 0;
try {
  await off.search({ startTokens: [] }); await shadow.search({ startTokens: [] });
  for (let i = 0; i < 40; i++) {
    for (const [name, worker] of [['off', off], ['shadow', shadow]] as const) {
      const started = performance.now();
      const result = await worker.search({ startTokens: [a], observedAt: Date.now(), splitCosts: splitCostsFromConstants() });
      timings[name].push(performance.now() - started);
      if (name === 'shadow' && result.some(opportunity => opportunity.split)) splitObservations++;
    }
  }
} finally { off.stop(); shadow.stop(); }
const percentiles = (values: number[]) => {
  values.sort((x, y) => x - y);
  return Object.fromEntries([50, 95, 99].map(p => [`p${p}Ms`, Number(values[Math.min(values.length - 1, Math.ceil(values.length * p / 100) - 1)].toFixed(3))]));
};
// Separate deterministic depletion experiment: a successful fill changes the next search state.
const depletion = new OpportunityEngine({ ...policy, splitSearchMs: 1000, maxSearchExpansions: 100000 });
depletion.graph.applyChanges(snapshot);
const fills: string[] = [];
for (let i = 0; i < 10; i++) {
  const candidate = depletion.findOpportunities({ startTokens: [a], splitCosts: splitCostsFromConstants() }).find(opportunity => opportunity.split);
  if (!candidate) break;
  const surplus = applyV2SplitFill(depletion.graph, candidate);
  if (surplus === null) throw new Error('Synthetic split fill did not match its quote');
  fills.push(surplus.toString());
}
console.log(JSON.stringify({ fixture: 'four synthetic V2 pools, one profit token', samples: 40,
  off: percentiles(timings.off), shadow: percentiles(timings.shadow), splitObservations,
  note: 'Repeated quote observations are not independent revenue. No RPC, signing or submission.',
  statefulV2Fills: fills.length, surplusBeforeGasPerFill: fills,
}, null, 2));
