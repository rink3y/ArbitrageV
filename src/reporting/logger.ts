import { NETWORK, RUNTIME, TELEGRAM, CONFIGURED_TOKENS } from '../constants';
import { ReportingChannel } from './channel';
import { type RecordLevel } from './records';
import { type MetricSamples } from './metrics';

let worker: Worker | undefined;
let channel: ReportingChannel | undefined;
let flushed = false;
let failed = false;
let health: unknown;

function emit(level: RecordLevel, args: readonly unknown[], key?: string): void {
  try { channel?.emit(level, args, key); } catch { /* Diagnostics cannot abort execution. */ }
}

export const logger = {
  get enabled() { return RUNTIME.logLevel !== 'off'; },
  get debugEnabled() { return RUNTIME.logLevel === 'debug'; },
  info(...args: unknown[]) { if (this.enabled) emit('info', args); },
  debug(...args: unknown[]) { if (this.debugEnabled) emit('debug', args); },
  warn(...args: unknown[]) { if (this.enabled) emit('warn', args); },
  error(...args: unknown[]) { if (this.enabled) emit('error', args); },
  // Independent of console level; key throttles repeats to once per minute.
  alert(key: string, level: RecordLevel, ...args: unknown[]) { emit(level, args, key); },
  metrics(snapshot: MetricSamples) { if (this.enabled) channel?.metrics(snapshot, this.debugEnabled); },
};

export function startReporting(): void {
  if (worker || channel) return;
  if (RUNTIME.logLevel === 'off' && (!TELEGRAM.botToken || !TELEGRAM.chatId)) return;
  failed = false;
  try {
    const options: Bun.WorkerOptions = { ref: false, name: 'reporting', env: {} };
    worker = new Worker(new URL('./worker.ts', import.meta.url).href, options);
    const secrets = Object.entries(process.env).filter(([key]) => /PRIVATE_KEY|BOT_TOKEN|RPC.*URL|API_KEY|PASSWORD|SECRET/i.test(key))
      .map(([, value]) => value!).filter(Boolean);
    channel = new ReportingChannel(worker, () => RUNTIME.logLevel, !!TELEGRAM.botToken && !!TELEGRAM.chatId, secrets);
    worker.onmessage = ({ data }) => {
      if (data.type === 'ack') { channel?.acknowledge(data.lane); health = data.health; }
      if (data.type === 'flushed') { flushed = true; health = data.stats; }
    };
    const fail = () => { failed = true; channel?.stop(); worker?.terminate(); worker = undefined; };
    worker.onerror = fail;
    worker.addEventListener('close', () => { if (worker) fail(); });
    worker.postMessage({ type: 'init', telegram: { ...TELEGRAM, timeoutMs: RUNTIME.notificationTimeoutMs,
      explorer: NETWORK.chain.blockExplorers?.default.url,
      tokens: CONFIGURED_TOKENS.map(({ address, name, decimals }) => ({ address, name, decimals })),
    } });
  } catch { failed = true; channel?.stop(); worker?.terminate(); worker = undefined; }
}

export function reportingStatus() { return { failed: failed || channel?.failed === true, ...channel?.stats, health }; }

// Only shutdown awaits reporting. A blocked terminal or Telegram cannot prevent exit.
export async function stopReporting(timeoutMs = RUNTIME.reportingShutdownMs): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (channel && !channel.idle && Date.now() < deadline) await Bun.sleep(5);
  flushed = false;
  if (worker && channel?.idle) {
    try { worker.postMessage({ type: 'flush' }); } catch { failed = true; }
    while (!flushed && !failed && Date.now() < deadline) await Bun.sleep(5);
  }
  const complete = !failed && !channel?.failed && (!worker || flushed);
  channel?.stop(); channel = undefined;
  const current = worker; worker = undefined;
  current?.terminate();
  return complete;
}
