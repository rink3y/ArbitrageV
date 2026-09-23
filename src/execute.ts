import { encodeFunctionData, type Address, type Hex } from 'viem';
import {
    CONTRACTS,
    EXECUTION_POLICY,
    RUNTIME,
    NETWORK,
    TELEGRAM,
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
import { formatTokenAmountWithSymbol } from './values';
import { BackgroundQueue, backgroundLogs } from './runtime/background-queue';
import { latency } from './runtime/latency';
import { ReceiptTracker } from './execution/receipt-tracker';

const TOKEN_PROFIT_SCALE = new Map(TOKENS.map(token => [token.address.toLowerCase(), token.minProfit]));

async function sendTransactionNotification(
    hash: string,
    expectedProfit: bigint,
    tokenAddress?: Address
): Promise<void> {
    if (!TELEGRAM.botToken || !TELEGRAM.chatId) return;

    const token = resolveToken(tokenAddress);
    const status = expectedProfit > 0n ? 'PROFIT' : 'WARNING';
    const explorer = NETWORK.chain.blockExplorers?.default.url;
    const message =
        `<b>${status}: Arbitrage Transaction</b>\n\n` +
        '<b>Type:</b> Flash Swap\n' +
        `<b>Expected Profit:</b> ${formatTokenAmountWithSymbol(expectedProfit, token)}\n\n` +
        `<b>Transaction:</b>\n` +
        `<code>${hash}</code>\n\n` +
        (explorer ? `<a href="${explorer.replace(/\/$/, '')}/tx/${hash}">View on Explorer</a>` : '');

    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM.botToken}/sendMessage`, {
            signal: AbortSignal.timeout(RUNTIME.notificationTimeoutMs),
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM.chatId,
                text: message,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            }),
        });
    } catch (error) {
        console.error('Failed to send Telegram notification:', error);
    }
}

function resolveToken(tokenAddress?: Address): Pick<(typeof TOKENS)[number], 'name' | 'decimals'> {
    if (!tokenAddress) return TOKENS[0] || { name: 'Unknown', decimals: 18 };

    const token = TOKENS.find(addr => addr.address.toLowerCase() === tokenAddress.toLowerCase());
    return token || { name: 'Unknown', decimals: 18 };
}

const PAIR_LOCK_TIMEOUT_MS = 30_000;

// Keeps route pools unavailable until their next local market update.
export class OpportunityManager {
    private lockedPairs: Map<string, number> = new Map();
    private readonly nonces: LocalNonces;
    private readonly notifications = new BackgroundQueue(128);
    private stopped = false;
    private readonly receipts: ReceiptTracker;
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
        this.receipts = new ReceiptTracker(hash => networkConfig.client.getTransactionReceipt({ hash }));
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
        this.notifications.stop();
        this.receipts.stop();
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

        if (RUNTIME.debug) backgroundLogs.enqueue('execution-debug', () => {
            console.log(`Processing ${sortedOpps.length} opportunities in profit order`);
        });

        for (const opp of sortedOpps) {
            if (!this.gasFees.isCurrent(feeSnapshot)) return;
            if (opp.netProfit !== undefined && opp.netProfit <= 0n) continue;
            if (opp.split && !this.splitExecutable(opp, feeSnapshot)) { latency.increment('split.notSubmitted'); continue; }
            if (!this.isFresh(graph, opp, feeSnapshot)) { latency.increment('execution.stale'); continue; }
            // Skip if any pairs conflict
            if (!this.tryLockPairs(opp.pairs)) {
                if (RUNTIME.debug) backgroundLogs.enqueue('execution-debug', () => {
                    console.log('Skipping opportunity due to pair conflict:', {
                        pairs: opp.pairs,
                        lockedPairs: Array.from(this.lockedPairs.keys())
                    });
                });
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

                if (RUNTIME.debug) backgroundLogs.enqueue('execution-debug', () => {
                    console.log('Submitted opportunity:', {
                        profit: opp.profit.toString(),
                        pairs: opp.pairs
                    });
                });
            } catch (error) {
                this.releasePairs(opp.pairs);
                if (RUNTIME.debug) backgroundLogs.enqueue('execution-debug', () => {
                    console.error('Failed to execute opportunity:', error);
                });
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
            if (RUNTIME.debug) backgroundLogs.enqueue('execution-debug', () => {
                console.log('Skipping opportunity without executable plan:', {
                    path: opportunity.path,
                    pairs: opportunity.pairs,
                    protocols: opportunity.protocols,
                });
            });
            return false;
        }

        if (RUNTIME.debug) backgroundLogs.enqueue('execution-debug', () => {
            console.log('Executing arbitrage:', {
                params: {
                    ...plan.params,
                    borrowAmount: plan.params.borrowAmount.toString(),
                    v2RepayFee: plan.params.v2RepayFee.toString(),
                    ...(plan.kind === 'flash' ? { fees: plan.params.fees.map(fee => fee.toString()) } : {}),
                },
                expectedProfit: opportunity.profit.toString()
            });
        });

        if (!this.isFresh(graph, opportunity, feeSnapshot)) return false;
        const account = this.networkConfig.account;
        if (account.type !== 'local') throw new Error('Execution requires a local signing account');
        const data = encodeFunctionData({ abi: ArbABI, functionName: plan.kind === 'split' ? 'executeSplitArbitrage' : 'executeArbitrage', args: [plan.params] });
        const nonce = this.nonces.reserve();
        let serializedTransaction: Hex;
        try {
            const signingStarted = performance.now();
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
            latency.observe('sign', performance.now() - signingStarted);
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
        const submittedAt = performance.now();
        try {
            hash = await this.networkConfig.walletClient.sendRawTransaction({ serializedTransaction });
        } catch (error) {
            this.nonces.submissionFailed(nonce);
            throw error;
        }
        latency.observe('submit.rpc', performance.now() - submittedAt);
        if (opportunity.observedAt) latency.observe('event.toSubmissionAck', Date.now() - opportunity.observedAt);
        this.receipts.track(hash, opportunity.observedAt);
        
        if (RUNTIME.debug) backgroundLogs.enqueue('execution-debug', () => {
            console.log('Transaction sent:', {
                hash,
                nonce,
                type: 'flashswap',
            });
        });

        this.notifications.enqueue(hash, () => sendTransactionNotification(
            hash,
            opportunity.profit,
            opportunity.path[opportunity.path.length - 1]
        ));

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
        return !!split && ARBITRAGE_SEARCH_POLICY.splitRouting === 'live' && split.mode === 'live' &&
            !!opportunity.marketVersions && opportunity.observedAt !== undefined &&
            split.costsValidUntil > Date.now() && split.deadline >= BigInt(Math.floor(Date.now() / 1000)) &&
            split.gasLimit === EXECUTION_POLICY.gasLimit && split.gasPriceWei === gasPriceCeiling(feeSnapshot);
    }
}
