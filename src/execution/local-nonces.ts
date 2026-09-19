// One allocator per dedicated trading wallet, in one process.
export class LocalNonces {
  private nextNonce: number | undefined;
  private readonly uncertain = new Set<number>();
  private readonly unsubmitted = new Set<number>();
  private refreshing: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    private readonly readPending: () => Promise<number>,
    private readonly refreshIntervalMs: number,
    private readonly retryIntervalMs: number,
  ) {
    for (const interval of [refreshIntervalMs, retryIntervalMs]) {
      if (!Number.isInteger(interval) || interval < 1 || interval > 2_147_483_647) {
        throw new Error('Nonce refresh intervals must be positive integer milliseconds within the timer limit');
      }
    }
  }

  // Startup awaits this before exposing the execution path.
  async start(): Promise<void> {
    if (this.stopped) throw new Error('Nonce allocator is stopped');
    if (this.nextNonce === undefined) await this.refresh();
  }

  reserve(): number {
    if (this.stopped) throw new Error('Nonce allocator is stopped');
    if (this.nextNonce === undefined) throw new Error('Nonce allocator has not been warmed');
    if (this.uncertain.size > 0) throw new Error('Transaction submissions paused for nonce reconciliation');
    if (this.unsubmitted.size > 0) {
      const nonce = Math.min(...this.unsubmitted);
      this.unsubmitted.delete(nonce);
      return nonce;
    }
    if (!Number.isSafeInteger(this.nextNonce + 1)) throw new Error('Nonce exceeds the safe integer range');
    // No await or RPC: concurrent callers reserve distinct values in this process.
    return this.nextNonce++;
  }

  submissionFailed(nonce: number): void {
    this.uncertain.add(nonce);
    console.error(`Submission of nonce ${nonce} failed or is uncertain; new submissions paused until the pending nonce advances past it. Inspect the transaction if this persists.`);
    this.refreshInBackground();
  }

  // Only for a local signing abort: these bytes have never reached a transport.
  releaseUnsubmitted(nonce: number): void {
    if (nonce < 0 || this.nextNonce === undefined || nonce >= this.nextNonce || this.uncertain.has(nonce)) throw new Error('Cannot release this nonce');
    this.unsubmitted.add(nonce);
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Nonce allocator is stopped'));
    if (this.refreshing) return this.refreshing;
    if (this.timer) clearTimeout(this.timer);
    let failed = false;
    this.refreshing = Promise.resolve().then(this.readPending).then(pending => {
      if (!Number.isSafeInteger(pending) || pending < 0) throw new Error('Invalid pending nonce from RPC');
      // A slow/stale response must not overwrite reservations made while it was in flight.
      this.nextNonce = Math.max(this.nextNonce ?? pending, pending);
      for (const nonce of this.unsubmitted) if (nonce < pending) this.unsubmitted.delete(nonce);
      for (const nonce of this.uncertain) {
        if (pending > nonce) this.uncertain.delete(nonce);
      }
    }).catch(error => {
      failed = true;
      throw error;
    }).finally(() => {
      this.refreshing = undefined;
      if (this.stopped) return;
      this.timer = setTimeout(
        () => this.refreshInBackground(),
        failed || this.uncertain.size > 0 ? this.retryIntervalMs : this.refreshIntervalMs,
      );
      this.timer.unref();
    });
    return this.refreshing;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private refreshInBackground(): void {
    if (this.stopped) return;
    void this.refresh().catch(error => console.error('Nonce refresh failed; retrying in the background:', error));
  }
}
