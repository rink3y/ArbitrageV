import { expect, test } from 'bun:test';
import { ReportingChannel } from '../src/reporting/channel';
import { safeArgs, formatReport, type Report, type Lane } from '../src/reporting/records';
import { LatencyMetrics, marketReceipt, recordMarketReceipt } from '../src/runtime/latency';
import { TelegramAlerts } from '../src/reporting/telegram';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('off does not inspect arguments or enqueue routine records; critical alerts remain independent', async () => {
  const messages: any[] = [];
  const channel = new ReportingChannel({ postMessage: message => messages.push(message) }, () => 'off', true);
  const argument = new Proxy({}, { ownKeys: () => { throw new Error('must not inspect'); } });
  channel.emit('debug', [argument]);
  channel.emit('info', [argument]);
  expect(channel.stats.queued).toBe(0);
  channel.emit('error', ['fatal'], 'fatal');
  await tick();
  expect(messages).toHaveLength(1);
  expect(messages[0].lane).toBe('alerts');
  channel.stop();
});

test('slow sinks cannot build an unbounded worker mailbox; alerts have a separate credit', async () => {
  const messages: any[] = [];
  const channel = new ReportingChannel({ postMessage: message => messages.push(message) }, () => 'debug', true);
  for (let i = 0; i < 10_000; i++) channel.emit('debug', ['sample', i]);
  expect(channel.stats.queued).toBe(256);
  expect(channel.stats.dropped.logs).toBe(9744);
  await tick();
  expect(messages).toHaveLength(1);
  expect(messages[0].records).toHaveLength(16);
  for (let i = 0; i < 1000; i++) channel.emit('info', ['more', i]);
  channel.emit('error', ['critical'], 'fatal');
  await tick();
  expect(messages).toHaveLength(2);
  expect(messages[1].lane).toBe('alerts');
  expect(channel.stats.inFlight).toBe(2);
  channel.acknowledge('logs');
  await tick();
  expect(messages).toHaveLength(3);
  channel.stop();
});

test('duplicate incidents are throttled, distinct transaction hashes are not coalesced', async () => {
  const messages: any[] = [];
  const channel = new ReportingChannel({ postMessage: message => messages.push(message) }, () => 'off', true);
  channel.emit('error', ['failed'], 'fees.failed');
  channel.emit('error', ['failed again'], 'fees.failed');
  channel.emit('info', ['tx 1'], 'submitted:1');
  channel.emit('info', ['tx 2'], 'submitted:2');
  await tick();
  expect(messages[0].records).toHaveLength(3);
  channel.stop();
});

test('worker transport failures do not throw into trading or retain queued work', async () => {
  const channel = new ReportingChannel({ postMessage: () => { throw new Error('closed'); } }, () => 'info', true);
  channel.emit('info', ['test']);
  await tick();
  expect(channel.stats.queued).toBe(0);
  expect(channel.stats.inFlight).toBe(0);
  channel.emit('error', ['late'], 'late');
  expect(channel.stats.queued).toBe(0);
});

test('records are bounded and redact keys, RPC URLs, signed bytes and nested errors', () => {
  const hash = '0x' + 'a'.repeat(64);
  const error = new Error('provider https://user:password@rpc.test/private failed secret-value');
  const input: any = { privateKey: 'private', hash, data: '0x' + 'b'.repeat(1000), error, nested: { token: 'secret-value' } };
  input.loop = input;
  Object.defineProperty(input, 'dangerous', { enumerable: true, get() { throw new Error('getter'); } });
  const text = JSON.stringify(safeArgs([input], true, ['secret-value']));
  expect(text).toContain(hash);
  expect(text).toContain('[redacted]');
  expect(text).not.toContain('secret-value');
  expect(text).not.toContain('user:password');
  expect(text).not.toContain('b'.repeat(100));
  expect(text.length).toBeLessThan(16_000);
  expect(JSON.stringify(safeArgs([error], false))).not.toContain('stack');
});

test('latency samples are bounded, tails require enough samples, and off preserves freshness receipts', () => {
  const metrics = new LatencyMetrics();
  metrics.observe('small', 1); metrics.observe('small', 100);
  expect(metrics.snapshot().stages.small).not.toHaveProperty('p95Ms');
  for (let i = 0; i < 1024; i++) metrics.observe('search', i);
  metrics.increment('dropped', 3);
  expect(metrics.snapshot().counters.dropped).toBe(3);
  expect(metrics.snapshot().stages.search).toEqual({ count: 1024, samples: 512, p50Ms: 767, p95Ms: 998, p99Ms: 1018, maxMs: 1023 });
  const disabled = new LatencyMetrics(() => false);
  disabled.observe('sign', 123); disabled.increment('events');
  expect(disabled.now()).toBe(0);
  expect(disabled.raw()).toEqual({ counters: {}, stages: {} });
  recordMarketReceipt('0xabc', 123);
  expect(marketReceipt('0xABC')).toBe(123);
});

const report: Report = { at: 0, level: 'error', args: ['A <safe> plain-text alert'] };
test('Telegram checks API success and does not interpret HTML or expose its credentials', async () => {
  const requests: RequestInit[] = [];
  const alerts = new TelegramAlerts({ botToken: 'fake-token', chatId: 'fake-chat', timeoutMs: 10 },
    (async (_url: unknown, options: RequestInit) => { requests.push(options); return Response.json({ ok: false, error_code: 401 }); }) as typeof fetch);
  alerts.enqueue(report);
  while (!alerts.idle) await tick();
  expect(alerts.failed).toBe(1);
  expect(requests).toHaveLength(1);
  expect(JSON.parse(requests[0].body as string)).not.toHaveProperty('parse_mode');
  expect(requests[0].body).not.toContain('fake-token');
  alerts.stop();
});

test('Telegram times out, retries once and bounds its queue while the request is blocked', async () => {
  let calls = 0;
  const alerts = new TelegramAlerts({ botToken: 'fake', chatId: 'fake', timeoutMs: 5 },
    ((_url: unknown, options: RequestInit) => new Promise((_resolve, reject) => {
      calls++;
      options.signal!.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
    })) as typeof fetch);
  alerts.enqueue(report);
  for (let i = 0; i < 100; i++) alerts.enqueue(report);
  expect(alerts.dropped).toBe(68);
  await Bun.sleep(1100);
  expect(alerts.failed).toBe(1);
  expect(calls).toBeGreaterThanOrEqual(2);
  alerts.stop();
});

test('Telegram retries a temporary API failure once and recognizes success', async () => {
  let calls = 0;
  const alerts = new TelegramAlerts({ botToken: 'fake', chatId: 'fake', timeoutMs: 50 },
    (async () => ++calls === 1 ? Response.json({ ok: false, error_code: 500 }) : Response.json({ ok: true })) as typeof fetch);
  alerts.enqueue(report);
  const deadline = Date.now() + 2000;
  try {
    while (!alerts.idle && Date.now() < deadline) await Bun.sleep(5);
    expect(alerts.sent).toBe(1);
    expect(alerts.failed).toBe(0);
    expect(calls).toBe(2);
  } finally { alerts.stop(); }
});

test('Telegram honors long rate limits across queued messages instead of retrying early', async () => {
  let calls = 0;
  const alerts = new TelegramAlerts({ botToken: 'fake', chatId: 'fake', timeoutMs: 50 },
    (async () => { calls++; return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 60 } }); }) as typeof fetch);
  alerts.enqueue(report); alerts.enqueue(report);
  await Bun.sleep(50);
  expect(calls).toBe(1);
  expect(alerts.failed).toBe(1);
  alerts.stop();
});

test('saturated debug drops before reading payloads and does not displace a critical alert', async () => {
  const messages: any[] = [];
  const channel = new ReportingChannel({ postMessage: message => messages.push(message) }, () => 'debug', true);
  for (let i = 0; i < 256; i++) channel.emit('debug', ['fill']);
  const argument = new Proxy({}, { ownKeys: () => { throw new Error('should not inspect'); } });
  channel.emit('debug', [argument]);
  for (let i = 0; i < 32; i++) channel.emit('info', ['tx'], `tx:${i}`);
  channel.emit('error', ['fatal'], 'fatal');
  await tick();
  expect(messages.find(message => message.lane === 'alerts').records[0].args).toEqual(['fatal']);
  expect(channel.stats.dropped.alerts).toBe(1);
  channel.stop();
});

test('a live reporting worker flushes offline output and never sends Telegram with empty credentials', async () => {
  const worker = new Worker(new URL('../src/reporting/worker.ts', import.meta.url).href);
  const replies: any[] = [];
  worker.onmessage = event => replies.push(event.data);
  worker.postMessage({ type: 'init', telegram: { botToken: '', chatId: '', timeoutMs: 5 } });
  for (const lane of ['logs', 'alerts'] as Lane[]) worker.postMessage({ type: 'batch', lane, records: [report], dropped: 0 });
  const deadline = Date.now() + 3000;
  try {
    while (replies.filter(reply => reply.type === 'ack').length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(replies.filter(reply => reply.type === 'ack')).toHaveLength(2);
    worker.postMessage({ type: 'flush' });
    while (!replies.some(reply => reply.type === 'flushed') && Date.now() < deadline) await Bun.sleep(5);
    expect(replies.find(reply => reply.type === 'flushed')?.stats).toMatchObject({ sent: 0, failed: 0, outputFailed: false });
  } finally { worker.terminate(); }
});

test('worker formatting distinguishes expired quotes from executable opportunities', () => {
  const output = formatReport({ at: 0, level: 'debug', args: ['Opportunity', { index: 1, status: 'expired; not executable',
    path: ['A', 'B', 'A'], pairs: ['pool'], fees: [30n], protocols: ['v2'], profit: 2n, optimalInput: 1n,
    ageMs: 600, ageLimitMs: 500 }] });
  expect(output).toContain('Quoted profit:');
  expect(output).toContain('expired; not executable');
  const valued = formatReport({ at: 0, level: 'debug', args: ['Opportunity', { index: 1, status: null,
    path: ['A', 'B'], pairs: ['pool'], fees: [30n], protocols: ['v2'], profit: 1000000n, netProfit: 1000000n,
    netProfitNative: 2n * 10n ** 18n, nativeToken: { name: 'NATIVE', decimals: 18 },
    optimalInput: 1000000n, ageLimitMs: 500, routeSwap: true, submissionMode: 'separate' }] });
  expect(valued).toContain('Estimated native net after gas: 2 NATIVE');
  expect(valued).not.toContain('Conservative net after gas');
  expect(valued).toContain('Prepared follow-up: separate');
});

test('shutdown has a deadline when the output pipe is not being drained', async () => {
  const child = Bun.spawn([process.execPath, 'run', './test/fixtures/reporting-lifecycle.ts', 'debug', 'flood'],
    { stdout: 'pipe', stderr: 'pipe' });
  const started = Date.now();
  const timer = setTimeout(() => child.kill(), 4000);
  try {
    // Deliberately do not read stdout until after exit.
    expect(await child.exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(3500);
    await new Response(child.stdout).text();
    expect(await new Response(child.stderr).text()).toBe('');
  } finally { clearTimeout(timer); child.kill(); }
});

for (const level of ['off', 'debug']) for (const fatal of [false, true]) {
  test(`reporting lifecycle ${level}, fatal=${fatal}: bounded exit and sanitized output`, async () => {
    const child = Bun.spawn([process.execPath, 'run', './test/fixtures/reporting-lifecycle.ts', level, fatal ? 'fatal' : 'normal'],
      { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child.kill(), 4000);
    try {
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(fatal ? 1 : 0);
      expect(err).toBe('');
      if (level === 'off') expect(out).toBe('');
      else {
        expect(out).toContain('SUBMISSIONS_STOPPED');
        if (fatal) {
          expect(out).toContain('fixture fatal');
          expect(out.indexOf('SUBMISSIONS_STOPPED')).toBeLessThan(out.indexOf('Bot stopped after a fatal error'));
          expect(out).not.toContain('private.rpc');
          expect(out).not.toContain('1'.repeat(64));
        }
      }
    } finally { clearTimeout(timer); child.kill(); }
  });
}
