export type MetricSamples = { counters: Record<string, number>; stages: Record<string, { count: number; values: number[] }> };

export function summarizeMetrics(raw: MetricSamples, debug = true) {
  return { counters: raw.counters, stages: Object.fromEntries(Object.entries(raw.stages)
    .filter(([name]) => debug || ['search', 'sign', 'submit.rpc', 'event.toSubmissionAck'].includes(name))
    .map(([name, sample]) => {
      const sorted = [...sample.values].sort((a, b) => a - b);
      const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
      return [name, { count: sample.count, samples: sorted.length, p50Ms: percentile(0.5),
        ...(sorted.length >= 20 ? { p95Ms: percentile(0.95) } : {}),
        ...(sorted.length >= 100 ? { p99Ms: percentile(0.99) } : {}), maxMs: sorted.at(-1) }];
    })) };
}
