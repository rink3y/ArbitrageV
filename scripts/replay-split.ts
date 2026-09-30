import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { type Address } from 'viem';
import { ARBITRAGE_SEARCH_POLICY } from '../src/constants';
import { type GraphChanges } from '../src/market-graph/changes';
import { OpportunityEngine } from '../src/opportunities/opportunity-engine';
import { replayJSON } from '../src/opportunities/split-replay';
import { type SplitCosts } from '../src/opportunities/split-routing';

// Read recorded graph snapshots/deltas only. Never constructs a network client or signer.
type Frame = { at: number; changes: GraphChanges; startTokens: Address[]; costs?: SplitCosts };
const file = process.argv[2];
if (!file) throw new Error('Usage: bun run replay:split recording.ndjson');
if (!(await Bun.file(file).exists())) throw new Error(`Recording not found: ${file}. Supply a recorded NDJSON file, or run bun run bench:split for an offline synthetic example.`);
const engine = new OpportunityEngine({ ...ARBITRAGE_SEARCH_POLICY, splitRouting: 'live' });
let frames = 0;
let splitFrames = 0;
let repeats = 0;
let previous = new Set<string>();
const elapsed: number[] = [];
for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  const frame = replayJSON.parse(line) as Frame;
  if (!Number.isFinite(frame.at) || !Array.isArray(frame.startTokens) || !frame.changes) throw new Error(`Invalid frame ${frames + 1}`);
  engine.graph.applyChanges(frame.changes);
  const now = Date.now();
  const started = performance.now();
  const result = engine.findOpportunities({ startTokens: frame.startTokens, observedAt: now,
    splitCosts: frame.costs && { ...frame.costs, validUntil: now + frame.costs.validUntil - frame.at } });
  elapsed.push(performance.now() - started);
  frames++;
  const splits = result.filter(opportunity => opportunity.split);
  if (splits.length) splitFrames++;
  const signatures = new Set(splits.map(opportunity => replayJSON.stringify([opportunity.path, opportunity.optimalInput, opportunity.split!.stages])));
  repeats += [...signatures].filter(key => previous.has(key)).length;
  previous = signatures;
  console.log(replayJSON.stringify({ frame: frames, at: frame.at, splitSearch: engine.lastSplitStats,
    quotes: result.map(opportunity => ({ kind: opportunity.split ? 'split' : 'linear', token: opportunity.path[0],
      amount: opportunity.optimalInput, net: opportunity.netProfit, grossAfterFlash: opportunity.profit })) }));
}
elapsed.sort((a, b) => a - b);
console.log(JSON.stringify({ frames, splitFrames, repeatedConsecutiveQuotes: repeats,
  p50Ms: elapsed[Math.floor(elapsed.length * 0.5)] ?? 0, p95Ms: elapsed[Math.min(elapsed.length - 1, Math.floor(elapsed.length * 0.95))] ?? 0,
  note: 'Observation replay, not P&L. Historical frames do not model our fills, inclusion, reverts or competition. No revenue total is computed.' }));
