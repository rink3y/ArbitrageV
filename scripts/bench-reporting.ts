import { RUNTIME, TELEGRAM } from '../src/constants';
import { logger, startReporting, stopReporting, reportingStatus } from '../src/reporting/logger';
import { type LogLevel } from '../src/reporting/records';

// Offline: the child uses the real reporting worker, with stdout discarded by
// the parent and Telegram explicitly disabled. It never creates a network client.
const selected = process.argv[2];
const load = process.argv[3] ?? 'steady';
const levels: LogLevel[] = ['off', 'info', 'debug'];
if (!selected) {
  for (const load of ['steady', 'saturated']) for (let repeat = 0; repeat < 3; repeat++) for (const level of levels) {
    const child = Bun.spawn([process.execPath, 'run', import.meta.path, level, load], { stdout: 'ignore', stderr: 'pipe' });
    const result = await new Response(child.stderr).text();
    if (await child.exited !== 0) throw new Error(result);
    console.log(JSON.stringify({ repeat: repeat + 1, ...JSON.parse(result) }));
  }
} else {
  if (!levels.includes(selected as LogLevel)) throw new Error('Expected off, info or debug');
  RUNTIME.logLevel = selected as LogLevel;
  Object.assign(TELEGRAM, { botToken: '', chatId: '' });
  startReporting();
  const times: number[] = [];
  const yields: number[] = [];
  let checksum = 0n;
  const path = ['token-a', 'token-b', 'token-a'];
  const pairs = ['pool-a', 'pool-b'];
  const quote = (i: number) => {
    const input = BigInt(i + 1);
    const output = input * 997n * 1_000_000n / (100_000_000n + input * 997n);
    checksum ^= output;
    // Representative caller mix: one summary per 100 events, detail for each
    // event in debug. Gates include the cost of constructing enabled records.
    if (logger.enabled && i % 100 === 0) logger.info('Search completed', { candidates: 64, sized: 32, winners: 2 });
    if (logger.debugEnabled) logger.debug('Sized candidate', { path, pairs, input, profit: output - input });
  };
  for (let i = 0; i < 5000; i++) { quote(i); if (i % 100 === 0) await Bun.sleep(0); }
  while (reportingStatus().queued || reportingStatus().inFlight) await Bun.sleep(1);
  const initialDropped = reportingStatus().dropped?.logs ?? 0;
  Bun.gc(true);
  const beforeHeap = process.memoryUsage().heapUsed;
  for (let i = 0; i < 50_000; i++) {
    const started = performance.now();
    quote(i);
    times.push((performance.now() - started) * 1000);
    if (i % 100 === 0) {
      const yielded = performance.now();
      await new Promise<void>(resolve => setImmediate(resolve));
      yields.push(performance.now() - yielded);
      if (load === 'steady') while (reportingStatus().queued || reportingStatus().inFlight) await Bun.sleep(1);
    }
  }
  const endHeap = process.memoryUsage().heapUsed;
  const gcStarted = performance.now();
  Bun.gc(true);
  const forcedGcMs = performance.now() - gcStarted;
  const retainedHeap = process.memoryUsage().heapUsed;
  const status = reportingStatus();
  const flushed = await stopReporting(5000);
  times.sort((a, b) => a - b); yields.sort((a, b) => a - b);
  const percentile = (values: number[], p: number) => values[Math.ceil(values.length * p) - 1];
  process.stderr.write(JSON.stringify({ level: selected, load, samples: times.length,
    p50Us: percentile(times, .5), p95Us: percentile(times, .95), p99Us: percentile(times, .99), p999Us: percentile(times, .999),
    maxUs: times.at(-1), yieldP99Ms: percentile(yields, .99), forcedGcMs,
    heapGrowthBytes: endHeap - beforeHeap, retainedGrowthBytes: retainedHeap - beforeHeap,
    droppedDuringMeasurement: (status.dropped?.logs ?? 0) - initialDropped, status, flushed, checksum: checksum.toString(),
  }));
}
