import { encodeFunctionData, type Address, type Hex } from 'viem';
import {
    CONTRACTS,
    EXECUTION_POLICY,
    RUNTIME,
    NETWORK,
    TOKENS,
    ARBITRAGE_SEARCH_POLICY,
} from './constants';
import ArbABI from './ABI/Arb.json';
import {
    createExecutionPlan,
    type ExecutableOpportunity,
    type FlashPoolLookup,
} from './execution/execution-planner';
import { type NetworkConfig } from './network';
import { LocalNonces } from './execution/local-nonces';
import { GasFees, gasPriceCeiling, type GasFeeSnapshot } from './execution/gas-fees';
import { logger } from './reporting/logger';
import { latency } from './runtime/latency';

const TOKEN_PROFIT_SCALE = new Map(TOKENS.map(token => [token.address.toLowerCase(), token.minProfit]));

const PAIR_LOCK_TIMEOUT_MS = 30_000;

// Keeps route pools unavailable until their next local market update.
export class OpportunityManager {
    private lockedPairs: Map<string, number> = new Map();
    private readonly nonces: LocalNonces;
    private stopped = false;
    private readonly gasFees: GasFees;

    constructor(
        private readonly networkConfig: NetworkConfig,
        private readonly submitOpportunity?: (
            graph: FlashPoolLookup,
            opportunity: ExecutableOpportunity
        ) => Promise<boolean>,
        gasFees?: GasFees,
    ) {
        this.gasFees = gasFees ?? new GasFees(type =>
            networkConfig.client.estimateFeesPerGas({ type, chain: networkConfig.client.chain }));
        this.nonces = new LocalNonces(
            () => networkConfig.client.getTransactionCount({ address: networkConfig.account.address, blockTag: 'pending' }),
            EXECUTION_POLICY.nonceRefreshIntervalMs,
            EXECUTION_POLICY.nonceRetryIntervalMs,
        );
    }

    async start(): Promise<void> {
        await this.gasFees.start();
        await this.nonces.start();
    }

    stop(): void {
        this.stopped = true;
        this.nonces.stop();
        this.gasFees.stop();
    }

    // Unlock only pools whose new state has already been applied locally.
    releasePairs(pairs: readonly Address[]): void {
        for (const pair of pairs) this.lockedPairs.delete(pair.toLowerCase());
    }

    private tryLockPairs(pairs: Address[]): boolean {
        const now = Date.now();
        for (const [pair, expiresAt] of this.lockedPairs) {
            if (expiresAt <= now) this.lockedPairs.delete(pair);
        }

        if (pairs.some(pair => this.lockedPairs.has(pair.toLowerCase()))) return false;

        const expiresAt = now + PAIR_LOCK_TIMEOUT_MS;
        for (const pair of pairs) this.lockedPairs.set(pair.toLowerCase(), expiresAt);
        return true;
    }

    // Process and execute a batch of opportunities
    async processOpportunities(
        graph: FlashPoolLookup,
        opportunities: ExecutableOpportunity[],
        feeSnapshot: GasFeeSnapshot | null = this.gasFees.current(),
    ): Promise<void> {
        if (!feeSnapshot || !this.gasFees.isCurrent(feeSnapshot)) return;
        // Sort opportunities by expected profit (descending)
        const sortedOpps = [...opportunities].sort((a, b) => {
            const aScale = TOKEN_PROFIT_SCALE.get(a.path[0].toLowerCase()) ?? 1n;
            const bScale = TOKEN_PROFIT_SCALE.get(b.path[0].toLowerCase()) ?? 1n;
            const aValue = (a.netProfit ?? a.profit) * bScale;
            const bValue = (b.netProfit ?? b.profit) * aScale;
            if (bValue > aValue) return 1;
            if (bValue < aValue) return -1;
            return 0;
        });

        if (logger.debugEnabled) logger.debug('Processing opportunities in profit order', sortedOpps.length);

        for (const opp of sortedOpps) {
            if (!this.gasFees.isCurrent(feeSnapshot)) return;
            if (opp.netProfit !== undefined && opp.netProfit <= 0n) continue;
            if (opp.split && !this.splitExecutable(opp, feeSnapshot)) { latency.increment('split.notSubmitted'); continue; }
            if (!this.isFresh(graph, opp, feeSnapshot)) { latency.increment('execution.stale'); continue; }
            // Skip if any pairs conflict
            if (!this.tryLockPairs(opp.pairs)) {
                if (logger.debugEnabled) logger.debug('Skipping pair conflict', { pairs: opp.pairs });
                continue;
            }

            try {
                // Execute the opportunity
                const executed = await (this.submitOpportunity
                    ? this.submitOpportunity(graph, opp)
                    : this.executeArbitrageOpportunity(graph, opp, feeSnapshot));
                if (!executed) {
                    this.releasePairs(opp.pairs);
                    continue;
                }

                if (logger.debugEnabled) logger.debug('Submitted opportunity', { profit: opp.profit, pairs: opp.pairs });
            } catch (error) {
                this.releasePairs(opp.pairs);
                logger.alert('execution.failed', 'error', 'Failed to execute opportunity', error);
            }
        }
    }

    private async executeArbitrageOpportunity(
        graph: FlashPoolLookup,
        opportunity: ExecutableOpportunity,
        feeSnapshot: GasFeeSnapshot,
    ): Promise<boolean> {
        if (!CONTRACTS.arbitrage || !CONTRACTS.arbitrage.match(/^0x[a-fA-F0-9]{40}$/)) {
            throw new Error('Invalid CONTRACTS.arbitrage address');
        }

        const plan = createExecutionPlan(graph, opportunity);
        if (!plan) {
            if (logger.debugEnabled) {
                logger.debug('Skipping opportunity without executable plan:', {
                    path: opportunity.path,
                    pairs: opportunity.pairs,
                    protocols: opportunity.protocols,
                });
            }
            return false;
        }

        if (logger.debugEnabled) logger.debug('Executing arbitrage', { params: plan.params, expectedProfit: opportunity.profit });

        if (!this.isFresh(graph, opportunity, feeSnapshot)) return false;
        const account = this.networkConfig.account;
        if (account.type !== 'local') throw new Error('Execution requires a local signing account');
        const data = encodeFunctionData({ abi: ArbABI, functionName: plan.kind === 'split' ? 'executeSplitArbitrage' : 'executeArbitrage', args: [plan.params] });
        const nonce = this.nonces.reserve();
        let serializedTransaction: Hex;
        try {
            const signingStarted = latency.now();
            // All transaction fields are known locally. No fill, estimation,
            // chain-ID, or nonce RPC belongs between detection and submission.
            serializedTransaction = await account.signTransaction({
                to: CONTRACTS.arbitrage as Address,
                data,
                chainId: this.networkConfig.walletClient.chain?.id ?? NETWORK.chain.id,
                nonce,
                gas: opportunity.split?.gasLimit ?? EXECUTION_POLICY.gasLimit,
                ...(feeSnapshot.type === 'legacy'
                    ? {
                        gasPrice: feeSnapshot.gasPrice,
                        type: 'legacy' as const,
                    }
                    : {
                        maxFeePerGas: feeSnapshot.maxFeePerGas,
                        maxPriorityFeePerGas: feeSnapshot.maxPriorityFeePerGas,
                        type: 'eip1559' as const,
                    }),
            }, { serializer: this.networkConfig.walletClient.chain?.serializers?.transaction });
            latency.elapsed('sign', signingStarted);
        } catch (error) {
            this.nonces.releaseUnsubmitted(nonce);
            throw error;
        }
        if (!this.isFresh(graph, opportunity, feeSnapshot)) {
            this.nonces.releaseUnsubmitted(nonce);
            latency.increment('execution.stale');
            return false;
        }
        let hash: Hex;
        const submittedAt = latency.now();
        try {
            hash = await this.networkConfig.walletClient.sendRawTransaction({ serializedTransaction });
        } catch (error) {
            this.nonces.submissionFailed(nonce);
            throw error;
        }
        latency.elapsed('submit.rpc', submittedAt);
        if (latency.enabled && opportunity.observedAt) latency.observe('event.toSubmissionAck', Date.now() - opportunity.observedAt);
        logger.alert(`submitted:${hash}`, 'info', 'Transaction submitted; check the explorer for its outcome', {
            hash, nonce, expectedProfitRaw: opportunity.profit, token: opportunity.path[0],
        });

        return true;
    }

    private isFresh(graph: FlashPoolLookup, opportunity: ExecutableOpportunity, feeSnapshot: GasFeeSnapshot): boolean {
        return !this.stopped && this.gasFees.isCurrent(feeSnapshot) &&
            (!opportunity.split || this.splitExecutable(opportunity, feeSnapshot)) &&
            (!opportunity.marketVersions || graph.matchesVersions?.(opportunity.marketVersions) === true) &&
            (opportunity.observedAt === undefined || Date.now() - opportunity.observedAt <= RUNTIME.candidateMaxAgeMs);
    }

    private splitExecutable(opportunity: ExecutableOpportunity, feeSnapshot: GasFeeSnapshot): boolean {
        const split = opportunity.split;
        return !!split && ARBITRAGE_SEARCH_POLICY.splitRouting === 'live' &&
            !!opportunity.marketVersions && opportunity.observedAt !== undefined &&
            split.costsValidUntil > Date.now() && split.deadline >= BigInt(Math.floor(Date.now() / 1000)) &&
            split.gasLimit === EXECUTION_POLICY.gasLimit && split.gasPriceWei === gasPriceCeiling(feeSnapshot);
    }
}
