import { formatReport, type Report, type Lane } from './records';
import { TelegramAlerts, type TelegramConfig } from './telegram';

declare const self: Worker;
let telegram: TelegramAlerts | undefined;
let outputFailed = false;
let formatFailed = 0;

// Await stdout backpressure here, never on the trading thread. At most one log
// batch is outstanding. Alert messages use a separate channel credit.
async function write(text: string): Promise<void> {
  if (outputFailed) return;
  await new Promise<void>(resolve => {
    process.stdout.write(text, error => { if (error) outputFailed = true; resolve(); });
  });
}
process.stdout.on('error', () => { outputFailed = true; });
self.onmessage = async (event: MessageEvent) => {
  const message = event.data;
  if (message.type === 'init') { telegram = new TelegramAlerts(message.telegram as TelegramConfig); return; }
  if (message.type === 'flush') {
    while (telegram && !telegram.idle) await Bun.sleep(10);
    self.postMessage({ type: 'flushed', stats: { sent: telegram?.sent ?? 0, failed: telegram?.failed ?? 0, dropped: telegram?.dropped ?? 0, outputFailed, formatFailed } });
    return;
  }
  if (message.type !== 'batch') return;
  const lane = message.lane as Lane;
  try {
    if (lane === 'alerts') {
      for (const report of message.records as Report[]) telegram?.enqueue(report);
    } else {
      if (message.dropped) await write(`Reporting dropped ${message.dropped} log records under load.\n`);
      for (const report of message.records as Report[]) {
        try { await write(formatReport(report)); } catch { formatFailed++; }
      }
    }
  } catch {
    formatFailed++;
  } finally {
    self.postMessage({ type: 'ack', lane, health: { outputFailed, formatFailed, telegramFailed: telegram?.failed ?? 0, telegramDropped: telegram?.dropped ?? 0 } });
  }
};
