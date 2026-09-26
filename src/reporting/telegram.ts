import { formatReport, type Report } from './records';
import { formatTokenAmountWithSymbol } from '../values';

export type TelegramConfig = { botToken: string; chatId: string; timeoutMs: number; explorer?: string;
  tokens?: ReadonlyArray<{ address: string; name: string; decimals: number }> };

export function formatAlert(report: Report, config: TelegramConfig): string {
  let text = formatReport(report);
  const details = report.args[1] as { hash?: string; token?: string; expectedProfitRaw?: bigint } | undefined;
  if (details?.expectedProfitRaw !== undefined) {
    const token = config.tokens?.find(token => token.address.toLowerCase() === details.token?.toLowerCase());
    if (token) text += `Expected profit, not realized: ${formatTokenAmountWithSymbol(details.expectedProfitRaw, token)}\n`;
  }
  if (details?.hash && /^0x[\da-f]{64}$/i.test(details.hash) && config.explorer) {
    text += `${config.explorer.replace(/\/$/, '')}/tx/${details.hash}\n`;
  }
  return text.slice(0, 3900);
}

// Runs only in the reporting worker. No caller awaits Telegram delivery.
export class TelegramAlerts {
  private pending: Report[] = [];
  private running = false;
  private stopped = false;
  private controller?: AbortController;
  private notBefore = 0;
  dropped = 0;
  failed = 0;
  sent = 0;
  constructor(private readonly config: TelegramConfig, private readonly request: typeof fetch = fetch) {}
  get idle(): boolean { return !this.running && !this.pending.length; }
  enqueue(report: Report): void {
    if (this.stopped || !this.config.botToken || !this.config.chatId) return;
    if (this.pending.length >= 32) {
      const disposable = this.pending.findIndex(item => item.level !== 'error');
      this.dropped++;
      if (disposable < 0 && report.level !== 'error') return;
      this.pending.splice(disposable < 0 ? 0 : disposable, 1);
    }
    if (report.level === 'error') this.pending.unshift(report);
    else this.pending.push(report);
    void this.drain();
  }
  stop(): void { this.stopped = true; this.pending.length = 0; this.controller?.abort(); }
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.stopped && this.pending.length) {
        if (Date.now() < this.notBefore) {
          await Bun.sleep(Math.min(1000, this.notBefore - Date.now()));
          continue;
        }
        const report = this.pending.shift()!;
        let body: string;
        try { body = JSON.stringify({ chat_id: this.config.chatId, text: formatAlert(report, this.config) }); }
        catch { this.failed++; continue; }
        let delivered = false;
        for (let attempt = 0; attempt < 2 && !this.stopped; attempt++) {
          this.controller = new AbortController();
          const timeout = setTimeout(() => this.controller?.abort(), this.config.timeoutMs);
          let delayMs = 1000;
          let retry = true;
          try {
            const response = await this.request(`https://api.telegram.org/bot${this.config.botToken}/sendMessage`, {
              method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: this.controller.signal,
            });
            const result = await response.json() as { ok?: boolean; error_code?: number; parameters?: { retry_after?: number } };
            if (response.ok && result.ok === true) { delivered = true; break; }
            const code = result.error_code ?? response.status;
            retry = code === 429 || code >= 500;
            delayMs = Math.max(1000, (result.parameters?.retry_after ?? 1) * 1000);
            if (code === 429) this.notBefore = Date.now() + Math.min(86_400_000, delayMs);
            if (delayMs > 5000) retry = false; // Do not retry earlier than Telegram permits.
          } catch { /* Bounded network retry. Never log credentials or response bodies. */ }
          finally { clearTimeout(timeout); }
          if (!retry || attempt === 1) break;
          await Bun.sleep(delayMs);
        }
        if (delivered) this.sent++; else this.failed++;
        this.notBefore = Math.max(this.notBefore, Date.now() + 1000);
      }
    } finally { this.running = false; }
  }
}
