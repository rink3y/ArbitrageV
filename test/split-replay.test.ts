import { v2Pair } from './helpers/markets';
import { expect, test } from 'bun:test';
import { MarketGraph } from '../src/market-graph/market-graph';
import { ARBITRAGE_SEARCH_POLICY, EXECUTION_POLICY, TOKENS } from '../src/constants';
import { applyV2SplitFill, replayJSON, type V2ReplayPlan } from '../src/opportunities/split-replay';
import { mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('offline V2 fills consume reserves instead of counting an unchanged quote as new revenue', () => {
  const graph = new MarketGraph(ARBITRAGE_SEARCH_POLICY);
  const [a, b] = TOKENS.map(token => token.address);
  const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const;
  for (const [id, x, y] of [[1, 1000n, 2000n], [2, 1000n, 2000n], [3, 2000n, 2000n], [4, 100000n, 100000n]] as const)
    graph.addPair(v2Pair(id, a, b, x, y, 0));
  const opportunity: V2ReplayPlan = { path: [a, b, a], optimalInput: 200n, flashPoolAddress: addr(4),
    split: { stages: [
      { tokenIn: a, tokenOut: b, branches: [1, 2].map(id => ({ pool: addr(id), protocol: 'v2', fee: 0, data: '0x', amountIn: 100n, minAmountOut: 181n })) },
      { tokenIn: b, tokenOut: a, branches: [{ pool: addr(3), protocol: 'v2', fee: 0, data: '0x', amountIn: 362n, minAmountOut: 306n }] },
    ], minSurplusAfterRepayment: 100n } };
  expect(applyV2SplitFill(graph, opportunity)).toBe(106n);
  expect(graph.getAllPairs().find(pair => pair.pairAddress === addr(1))?.reserve0).toBe(1100n);
  const before = graph.getAllPairs().map(pair => ({ ...pair }));
  expect(applyV2SplitFill(graph, opportunity)).toBeNull();
  expect(graph.getAllPairs()).toEqual(before);
});

test('recorded NDJSON replays through the offline CLI without credentials or a revenue total', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arb-split-replay-'));
  const file = join(directory, 'recording.ndjson');
  const graph = new MarketGraph(ARBITRAGE_SEARCH_POLICY);
  const [a, b] = TOKENS.map(token => token.address);
  for (const [id, x, y] of [[1, 1000n, 2000n], [2, 1000n, 2000n], [3, 2000n, 2000n], [4, 100000n, 100000n]] as const)
    graph.addPair(v2Pair(id, a, b, x, y, 0));
  const costs = { validUntil: 11000, gasPriceWei: 1n, rates: { [a.toLowerCase()]: { numerator: 1n, denominator: EXECUTION_POLICY.gasLimit } } };
  const frames = [
    { at: 1000, changes: graph.takeChanges(true), startTokens: [a], costs },
    { at: 1001, changes: graph.takeChanges(), startTokens: [a], costs },
  ];
  try {
    await Bun.write(file, frames.map(frame => replayJSON.stringify(frame)).join('\n') + '\n');
    const script = `
      const { ARBITRAGE_SEARCH_POLICY, TOKENS } = await import(${JSON.stringify(new URL('../src/constants.ts', import.meta.url).href)});
      ARBITRAGE_SEARCH_POLICY.splitSearchMs = 1000;
      ARBITRAGE_SEARCH_POLICY.maxSearchExpansions = 100000;
      ARBITRAGE_SEARCH_POLICY.maxInputReserveFraction = 5n;
      TOKENS[0].minProfit = 1n;
      process.argv[2] = ${JSON.stringify(file)};
      await import(${JSON.stringify(new URL('../scripts/replay-split.ts', import.meta.url).href)});
    `;
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe(''); expect(code).toBe(0);
    const lines = stdout.trim().split('\n');
    const summary = JSON.parse(lines.at(-1)!);
    expect(summary.frames).toBe(2);
    expect(summary.splitFrames).toBe(2);
    expect(summary.repeatedConsecutiveQuotes).toBe(1);
    expect(summary.note).toContain('No revenue total');
  } finally { await unlink(file); await rmdir(directory); }
}, 10000);
