import { formatGwei } from 'viem';
import { EXECUTION_POLICY } from '../constants';

type FeePolicy = {
  feeMode: 'manual' | 'auto';
  feeRefreshIntervalMs: number;
  autoMaxFeePerGas: bigint;
  legacy: boolean;
  legacyGasPrice: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

type FeeEstimate = { gasPrice?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint };

export type GasFeeSnapshot = (
  | { type: 'legacy'; gasPrice: bigint }
  | { type: 'eip1559'; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
) & { validUntil: number };

export function gasPriceCeiling(fees: GasFeeSnapshot): bigint {
  return fees.type === 'legacy' ? fees.gasPrice : fees.maxFeePerGas;
}

// One fee source for search and signing. Auto refreshes never run on the trade path.
export class GasFees {
  private value: GasFeeSnapshot | null;
  private timer?: ReturnType<typeof setInterval>;
  private refreshing = false;
  private stopped = false;

  constructor(
    private readonly estimate: (type: 'legacy' | 'eip1559') => Promise<FeeEstimate>,
    private readonly policy: FeePolicy = EXECUTION_POLICY,
  ) {
    if (!Number.isSafeInteger(policy.feeRefreshIntervalMs) || policy.feeRefreshIntervalMs < 1 ||
        policy.autoMaxFeePerGas <= 0n) throw new Error('Invalid gas fee policy');
    this.value = policy.feeMode === 'manual' ? this.manualFees() : null;
  }

  async start(): Promise<void> {
    if (this.policy.feeMode !== 'auto' || this.timer || this.stopped) return;
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

  private manualFees(): GasFeeSnapshot {
    if (this.policy.legacy) {
      if (this.policy.legacyGasPrice <= 0n) throw new Error('Invalid manual gas price');
      return { type: 'legacy', gasPrice: this.policy.legacyGasPrice, validUntil: Number.MAX_SAFE_INTEGER };
    }
    if (this.policy.maxFeePerGas <= 0n || this.policy.maxPriorityFeePerGas < 0n ||
        this.policy.maxPriorityFeePerGas > this.policy.maxFeePerGas) throw new Error('Invalid manual EIP-1559 fees');
    return { type: 'eip1559', maxFeePerGas: this.policy.maxFeePerGas,
      maxPriorityFeePerGas: this.policy.maxPriorityFeePerGas, validUntil: Number.MAX_SAFE_INTEGER };
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
        console.warn('Auto gas fee estimate was invalid; submissions paused.');
        return;
      }
      if (gasPriceCeiling(next) > this.policy.autoMaxFeePerGas) {
        this.value = null;
        console.warn(`Auto gas estimate ${formatGwei(gasPriceCeiling(next))} gwei exceeds ceiling ` +
          `${formatGwei(this.policy.autoMaxFeePerGas)} gwei; submissions paused.`);
        return;
      }
      this.value = next;
      console.log(`Auto gas fees refreshed: ${formatGwei(gasPriceCeiling(next))} gwei ceiling`);
    } catch {
      if (!this.stopped) {
        this.value = null;
        console.warn('Auto gas fee refresh failed; submissions paused until a refresh succeeds.');
      }
    } finally {
      this.refreshing = false;
    }
  }
}
