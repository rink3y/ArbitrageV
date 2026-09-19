import { RUNTIME } from '../constants';
import { type MarketGraph } from '../market-graph/market-graph';
import { type ArbitrageSearchPolicy } from '../market-graph/types';
import { latency } from '../runtime/latency';
import { type ArbitrageSearchResult, type FindOpportunitiesRequest } from './opportunity-types';

// The scanner has one running job; its scheduler coalesces subsequent dirty
// markets. Updates stay on the authoritative graph until the next transfer.
export class WorkerSearch {
  private worker: Worker | undefined;
  private pending: { resolve: (result: ArbitrageSearchResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  private stopped = false;

  constructor(private readonly graph: MarketGraph, private readonly policy: ArbitrageSearchPolicy) {}

  search(request: FindOpportunitiesRequest): Promise<ArbitrageSearchResult> {
    if (this.stopped) return Promise.reject(new Error('Search worker is stopped'));
    if (this.pending) return Promise.reject(new Error('Search worker already has a running job'));
    const full = !this.worker;
    if (!this.worker) {
      this.worker = new Worker(new URL('./search-worker.ts', import.meta.url).href);
      this.worker.onmessage = event => {
        const pending = this.pending;
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending = undefined;
        if (event.data.error) { this.reset(); pending.reject(new Error(event.data.error)); return; }
        latency.observe('worker.apply', event.data.applyMs);
        latency.observe('search', event.data.searchMs);
        latency.increment('search.candidates', event.data.stats.candidates);
        latency.increment('search.sized', event.data.stats.sized);
        pending.resolve(event.data.opportunities);
      };
      this.worker.onerror = event => this.fail(new Error(event.message || 'Search worker failed'));
      const worker = this.worker;
      this.worker.addEventListener('close', () => { if (this.worker === worker && this.pending) this.fail(new Error('Search worker closed')); });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Search worker timed out')), RUNTIME.searchTimeoutMs);
      this.pending = { resolve, reject, timer };
      try {
        const started = performance.now();
        this.worker!.postMessage({ policy: this.policy, changes: this.graph.takeChanges(full), request });
        latency.observe('worker.transfer', performance.now() - started);
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  stop(): void { this.stopped = true; this.fail(new Error('Search worker stopped')); }
  private reset(): void {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) { worker.onmessage = null; worker.onerror = null; worker.terminate(); }
  }
  private fail(error: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
    this.reset();
  }
}
