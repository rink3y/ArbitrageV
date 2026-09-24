import { logger } from '../reporting/logger';
import { EXECUTION_POLICY } from '../constants';

type FeePolicy = {
  feeRefreshIntervalMs: number;
  feeCeilingPerGas: bigint;
  legacy: boolean;
};

type FeeEstimate = { gasPrice?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint };

export type GasFeeSnapshot = (
  | { type: 'legacy'; gasPrice: bigint }
  | { type: 'eip1559'; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
) & { validUntil: number };

export function gasPriceCeiling(fees: GasFeeSnapshot): bigint {
  return fees.type === 'legacy' ? fees.gasPrice : fees.maxFeePerGas;
}

// One fee source for search and signing. Refreshes never run on the trade path.
export class GasFees {
  private value: GasFeeSnapshot | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private refreshing = false;
  private stopped = false;
  private paused = false;

  constructor(
    private readonly estimate: (type: 'legacy' | 'eip1559') => Promise<FeeEstimate>,
    private readonly policy: FeePolicy = EXECUTION_POLICY,
  ) {
    if (!Number.isSafeInteger(policy.feeRefreshIntervalMs) || policy.feeRefreshIntervalMs < 1 ||
        policy.feeCeilingPerGas <= 0n) throw new Error('Invalid gas fee policy');
  }

  async start(): Promise<void> {
    if (this.timer || this.stopped) return;
    await this.refresh();
    if (this.stopped) return;
    this.timer = setInterval(() => { void this.refresh(); }, this.policy.feeRefreshIntervalMs);
    this.timer.unref?.();
  }

  current(): GasFeeSnapshot | null {
    return this.value && this.value.validUntil > Date.now() ? this.value : null;
  }

  isCurrent(value: GasFeeSnapshot): boolean {
    return !this.stopped && this.current() === value;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.value = null;
  }

  private async refresh(): Promise<void> {
    if (this.refreshing || this.stopped) return;
    this.refreshing = true;
    try {
      const estimate = await this.estimate(this.policy.legacy ? 'legacy' : 'eip1559');
      if (this.stopped) return;
      const validUntil = Date.now() + 2 * this.policy.feeRefreshIntervalMs;
      const next: GasFeeSnapshot | null = this.policy.legacy
        ? estimate.gasPrice && estimate.gasPrice > 0n
          ? { type: 'legacy', gasPrice: estimate.gasPrice, validUntil } : null
        : estimate.maxFeePerGas && estimate.maxFeePerGas > 0n &&
            estimate.maxPriorityFeePerGas !== undefined && estimate.maxPriorityFeePerGas >= 0n &&
            estimate.maxPriorityFeePerGas <= estimate.maxFeePerGas
          ? { type: 'eip1559', maxFeePerGas: estimate.maxFeePerGas,
            maxPriorityFeePerGas: estimate.maxPriorityFeePerGas, validUntil } : null;
      if (!next) {
        this.value = null;
        this.pause('Gas fee estimate was invalid; submissions paused.');
        return;
      }
      if (gasPriceCeiling(next) > this.policy.feeCeilingPerGas) {
        this.value = null;
        this.pause('Gas estimate exceeds configured ceiling; submissions paused.');
        return;
      }
      this.value = next;
      if (this.paused) logger.alert('fees.recovered', 'info', 'Gas fees recovered; fee gate reopened');
      this.paused = false;
      if (logger.enabled) logger.info('Gas fees refreshed', next);
    } catch (error) {
      if (!this.stopped) {
        this.value = null;
        this.pause('Gas fee refresh failed; submissions paused until a refresh succeeds.', error);
      }
    } finally {
      this.refreshing = false;
    }
  }
  private pause(message: string, error?: unknown): void {
    this.paused = true;
    logger.alert('fees.paused', 'error', message, error);
  }
}
