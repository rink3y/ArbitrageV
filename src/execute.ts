import { encodeFunctionData, type Address, type Hex } from 'viem';
import {
    CONTRACTS,
    EXECUTION_POLICY,
    RUNTIME,
    NETWORK,
    ARBITRAGE_SEARCH_POLICY,
    WRAPPED_NATIVE_TOKENS,
} from './constants';
import ArbABI from './ABI/Arb.json';
import {
    createExecutionPlan,
    gasLimitForTransaction,
    contractPlan,
    type ExecutionPlan,
    type ExecutableOpportunity,
    type FlashPoolLookup,
} from './execution/execution-planner';
import { type NetworkConfig } from './network';
import { LocalNonces } from './execution/local-nonces';
import { GasFees, gasPriceCeiling, type GasFeeSnapshot } from './execution/gas-fees';
import { logger } from './reporting/logger';
import { latency } from './runtime/latency';


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
        if (EXECUTION_POLICY.routeSwapFunding || EXECUTION_POLICY.followUpMode !== 'off' || WRAPPED_NATIVE_TOKENS.length > 1) {
            if (!CONTRACTS.arbitrage?.match(/^0x[a-fA-F0-9]{40}$/)) throw new Error('Invalid CONTRACTS.arbitrage address');
            const helper = await this.networkConfig.client.readContract({
                address: CONTRACTS.arbitrage as Address, abi: ArbABI, functionName: 'v2Logic',
            });
            if (typeof helper !== 'string' || !helper.match(/^0x(?!0{40}$)[a-fA-F0-9]{40}$/))
                throw new Error('Configured NArb does not expose the protocol modules');
            for (const { address: wrapper } of WRAPPED_NATIVE_TOKENS) {
                const approved = await this.networkConfig.client.readContract({
                    address: CONTRACTS.arbitrage as Address, abi: ArbABI, functionName: 'approvedWrapper', args: [wrapper],
                });
                if (approved !== true) throw new Error('NArb has not approved wrapper ' + wrapper);
            }
        }
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
            if (a.netProfitNative !== undefined || b.netProfitNative !== undefined) {
                const left = a.netProfitNative ?? -1n, right = b.netProfitNative ?? -1n;
                return left > right ? -1 : left < right ? 1 : 0;
            }
            const aValue = a.netProfit ?? a.profit;
            const bValue = b.netProfit ?? b.profit;
            if (bValue > aValue) return 1;
            if (bValue < aValue) return -1;
            return 0;
        });

        if (logger.debugEnabled) logger.debug('Processing opportunities in profit order', sortedOpps.length);

        for (const opp of sortedOpps) {
            if (!this.gasFees.isCurrent(feeSnapshot)) return;
            if ((opp.netProfitNative ?? opp.netProfit ?? opp.profit) <= 0n) continue;
            if (opp.split && !this.splitExecutable(opp, feeSnapshot)) { latency.increment('split.notSubmitted'); continue; }
            if (!this.isFresh(graph, opp, feeSnapshot)) { latency.increment('execution.stale'); continue; }
            // Skip if any pairs conflict
            const next = EXECUTION_POLICY.followUpMode !== 'off' && opp.followUpPlan && opp.followUp &&
                this.isFresh(graph, opp.followUp, feeSnapshot) ? opp.followUp : undefined;
            // Flash liquidity is repaid inside each transaction. Preserve concurrent
            // disjoint routes sharing a lender; first-swap funding is already in pairs.
            const pools = [...new Set([...opp.pairs, ...(next?.pairs ?? [])])];
            if (!this.tryLockPairs(pools)) {
                if (logger.debugEnabled) logger.debug('Skipping pair conflict', { pairs: opp.pairs });
                continue;
            }

            try {
                // Execute the opportunity
                const executed = await (this.submitOpportunity
                    ? this.submitOpportunity(graph, opp)
                    : this.executeSequence(graph, next ? opp : { ...opp, followUp: undefined, followUpPlan: undefined }, feeSnapshot));
                if (!executed) {
                    this.releasePairs(pools);
                    continue;
                }

                if (logger.debugEnabled) logger.debug('Submitted opportunity', { profit: opp.profit, pairs: opp.pairs });
            } catch (error) {
                this.releasePairs(pools);
                logger.alert('execution.failed', 'error', 'Failed to execute opportunity', error);
            }
        }
    }

    private async executeArbitrageOpportunity(
        graph: FlashPoolLookup,
        opportunity: ExecutableOpportunity,
        feeSnapshot: GasFeeSnapshot,
        planOverride?: ExecutionPlan,
        reservedNonce?: number,
    ): Promise<boolean> {
        let transportAttempted = false;
        try {
            if (!CONTRACTS.arbitrage || !CONTRACTS.arbitrage.match(/^0x[a-fA-F0-9]{40}$/)) {
                throw new Error('Invalid CONTRACTS.arbitrage address');
            }

            const plan = planOverride ?? createExecutionPlan(graph, opportunity);
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
            const batch = EXECUTION_POLICY.followUpMode === 'batch' && opportunity.followUp && opportunity.followUpPlan;
            if (batch && !this.isFresh(graph, opportunity.followUp!, feeSnapshot)) return false;
            const data = batch
                ? encodeFunctionData({ abi: ArbABI, functionName: 'executeBatch', args: [[contractPlan(plan), opportunity.followUpPlan]] })
                : plan.kind === 'plan'
                ? encodeFunctionData({ abi: ArbABI, functionName: 'executePlan', args: [plan.params] })
                : plan.kind === 'v2-route-flash'
                ? encodeFunctionData({ abi: ArbABI, functionName: 'executeV2RouteFlash',
                    args: [plan.params.startToken, plan.params.amountIn, plan.params.pools, plan.params.fees] })
                : encodeFunctionData({ abi: ArbABI,
                    functionName: plan.kind === 'split' ? 'executeSplitArbitrage' : 'executeArbitrage', args: [plan.params] });
            const nonce = reservedNonce ?? this.nonces.reserve();
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
                    gas: gasLimitForTransaction(batch ? 'batch' : 'single'),
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
            if (!this.isFresh(graph, opportunity, feeSnapshot) ||
                (batch && !this.isFresh(graph, opportunity.followUp!, feeSnapshot))) {
                this.nonces.releaseUnsubmitted(nonce);
                latency.increment('execution.stale');
                return false;
            }
            let hash: Hex;
            const submittedAt = latency.now();
            try {
                transportAttempted = true;
                hash = await this.networkConfig.walletClient.sendRawTransaction({ serializedTransaction });
            } catch (error) {
                this.nonces.submissionFailed(nonce);
                throw error;
            }
            latency.elapsed('submit.rpc', submittedAt);
            if (latency.enabled && opportunity.observedAt) latency.observe('event.toSubmissionAck', Date.now() - opportunity.observedAt);
            logger.alert(`submitted:${hash}`, 'info', 'Transaction submitted; check the explorer for its outcome', {
                hash, nonce, expectedProfitRaw: opportunity.profit + (batch ? opportunity.followUp!.profit : 0n), token: opportunity.path[0],
            });

            return true;
        } finally {
            // Sequence nonces were reserved before planning/encoding. Return one
            // even when validation throws, but never after bytes reach transport.
            if (reservedNonce !== undefined && !transportAttempted) this.nonces.releaseUnsubmitted(reservedNonce);
        }
    }

    private async executeSequence(graph: FlashPoolLookup, opportunity: ExecutableOpportunity, fees: GasFeeSnapshot): Promise<boolean> {
        if (EXECUTION_POLICY.followUpMode !== 'separate' || !opportunity.followUp || !opportunity.followUpPlan)
            return this.executeArbitrageOpportunity(graph, opportunity, fees);
        const nonces = this.nonces.reserveSequence();
        if (!nonces) return this.executeArbitrageOpportunity(graph, { ...opportunity, followUp: undefined }, fees);
        let firstSubmitted = false;
        let secondAttempted = false;
        try {
            firstSubmitted = await this.executeArbitrageOpportunity(graph, opportunity, fees, undefined, nonces[0]);
            if (!firstSubmitted) return false;
            if (!this.isFresh(graph, opportunity.followUp, fees)) return true;
            secondAttempted = true;
            try {
                await this.executeArbitrageOpportunity(graph, opportunity.followUp, fees,
                    { kind: 'plan', params: opportunity.followUpPlan }, nonces[1]);
            } catch (error) {
                // A is already broadcast. Keep its locks, even if signing or sending B fails.
                logger.alert('execution.followUpFailed', 'error', 'First trade submitted; follow-up failed', error);
            }
            return true;
        } finally {
            if (!firstSubmitted) this.nonces.releaseUnsubmitted(nonces[1]);
            else if (!secondAttempted) this.nonces.releaseUnsubmitted(nonces[1]);
        }
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
            split.gasLimit === gasLimitForTransaction() && split.gasPriceWei === gasPriceCeiling(feeSnapshot);
    }
}
