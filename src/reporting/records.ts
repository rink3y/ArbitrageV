export type LogLevel = 'off' | 'info' | 'debug';
export type RecordLevel = 'info' | 'debug' | 'warn' | 'error';
import { summarizeMetrics, type MetricSamples } from './metrics';
import { formatTokenAmountWithSymbol, basisPoints, formatBasisPoints } from '../values';
export type Report = { level: RecordLevel; at: number; args: unknown[]; key?: string; metrics?: MetricSamples; detail?: boolean };
export type Lane = 'logs' | 'alerts';

// Bound both traversal and copied data before crossing the worker channel.
// Never inspect provider error properties, causes, request bodies or signed bytes.
export function safeArgs(args: readonly unknown[], debug: boolean, secrets: readonly string[] = []): unknown[] {
  let remaining = 8192;
  let nodes = 256;
  const clean = (value: string): string => {
    const limit = Math.min(remaining, 2048);
    // Look beyond the output cut so truncation cannot expose a secret prefix.
    let text = value.slice(0, limit + 2048);
    for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[redacted]');
    text = text.replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
      .replace(/\b\d{6,}:[\w-]{20,}\b/g, '[redacted]')
      .replace(/0x[\da-f]{64,}/gi, '[hex payload redacted]');
    text = text.slice(0, limit);
    remaining -= text.length;
    return text;
  };
  const copy = (value: unknown, depth: number, key = ''): unknown => {
    if (--nodes < 0 || remaining <= 0 || depth > 5) return '[truncated]';
    if (/private|secret|password|authorization|botToken|serializedTransaction|signedTransaction|apiKey/i.test(key)) return '[redacted]';
    if (value instanceof Error) return { name: clean(value.name), message: clean(value.message), ...(debug ? { stack: clean(value.stack ?? '') } : {}) };
    // Transaction hashes are public identifiers; do not redact them as keys.
    if (typeof value === 'string') return key === 'hash' && /^0x[\da-f]{64}$/i.test(value) ? value : clean(value);
    if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
    if (Array.isArray(value)) return value.slice(0, 32).map(item => copy(item, depth + 1));
    if (typeof value === 'object') {
      const result: Record<string, unknown> = {};
      let count = 0;
      for (const name in value) {
        if (++count > 24 || nodes <= 0 || remaining <= 0) { result.truncated = true; break; }
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (descriptor && 'value' in descriptor) result[clean(name)] = copy(descriptor.value, depth + 1, name);
      }
      return result;
    }
    return '[unsupported]';
  };
  return args.slice(0, 8).map(value => copy(value, 0));
}

export function formatReport(report: Report): string {
  if (report.metrics) return formatReport({ ...report, metrics: undefined, args: ['Latency', summarizeMetrics(report.metrics, report.detail)] });
  if (report.args[0] === 'Opportunity') return formatOpportunity(report.args[1]);
  return `${new Date(report.at).toISOString()} ${report.level.toUpperCase()} ` + report.args.map(value =>
    typeof value === 'string' ? value : JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item)
  ).join(' ') + '\n';
}

function formatOpportunity(value: unknown): string {
  const quote = value as { index: number; status: string | null; path: string[]; profit: bigint; netProfit?: bigint;
    optimalInput: bigint; pairs: string[]; fees: bigint[]; protocols: string[]; ageMs?: number; ageLimitMs: number;
    inputToken?: { name: string; decimals: number }; profitToken?: { name: string; decimals: number } };
  const amount = (raw: bigint, token?: { name: string; decimals: number }) => token ? formatTokenAmountWithSymbol(raw, token) : `${raw} raw units`;
  return [quote.status ? `Quote #${quote.index} (${quote.status})` : `Opportunity #${quote.index}`,
    `Path: ${quote.path.join(' -> ')}`,
    `${quote.status ? 'Quoted' : 'Expected'} profit: ${amount(quote.profit, quote.profitToken)}`,
    ...(quote.netProfit === undefined ? [] : [`Conservative net after gas: ${amount(quote.netProfit, quote.profitToken)}`]),
    `Optimal input: ${amount(quote.optimalInput, quote.inputToken)}`,
    `Profit percentage: ${formatBasisPoints(basisPoints(quote.profit, quote.optimalInput))}%`,
    `Age at check: ${quote.ageMs ?? 'unknown'} ms (limit ${quote.ageLimitMs} ms)`,
    `Protocols: ${quote.protocols.join(', ')}`, `Pairs used: ${quote.pairs.join(', ')}`, `Fees: ${quote.fees.join(', ')}`,
  ].join('\n') + '\n';
}
