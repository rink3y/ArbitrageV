import { type Address } from 'viem';
import {
    CONTRACTS,
    EXECUTION_POLICY,
    RUNTIME,
    TELEGRAM,
    TOKENS,
} from './constants';
import ArbABI from './ABI/Arb.json';
import {
    createExecutionPlan,
    type ExecutableOpportunity,
    type FlashPoolLookup,
} from './execution/execution-planner';
import { type NetworkConfig } from './network';
import { LocalNonces } from './execution/local-nonces';
import { formatTokenAmountWithSymbol } from './values';

const TOKEN_PROFIT_SCALE = new Map(TOKENS.map(token => [token.address.toLowerCase(), token.minProfit]));

async function sendTransactionNotification(
    hash: string,
    expectedProfit: bigint,
    tokenAddress?: Address
): Promise<void> {
    if (!TELEGRAM.botToken || !TELEGRAM.chatId) return;

    const token = resolveToken(tokenAddress);
    const status = expectedProfit > 0n ? 'PROFIT' : 'WARNING';
    const message =
        `<b>${status}: Arbitrage Transaction</b>\n\n` +
        '<b>Type:</b> Flash Swap\n' +
        `<b>Expected Profit:</b> ${formatTokenAmountWithSymbol(expectedProfit, token)}\n\n` +
        `<b>Transaction:</b>\n` +
        `<code>${hash}</code>\n\n` +
        `<a href="https://seiscan.io/tx/${hash}">View on Explorer</a>`;

    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM.botToken}/sendMessage`, {
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

    constructor(
        private readonly networkConfig: NetworkConfig,
        private readonly submitOpportunity?: (
            graph: FlashPoolLookup,
            opportunity: ExecutableOpportunity
        ) => Promise<boolean>
    ) {
        this.nonces = new LocalNonces(
            () => networkConfig.client.getTransactionCount({ address: networkConfig.account.address, blockTag: 'pending' }),
            EXECUTION_POLICY.nonceRefreshIntervalMs,
            EXECUTION_POLICY.nonceRetryIntervalMs,
        );
    }

    async start(): Promise<void> {
        await this.nonces.start();
    }

    stop(): void {
        this.nonces.stop();
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
        opportunities: ExecutableOpportunity[]
    ): Promise<void> {
        // Sort opportunities by expected profit (descending)
        const sortedOpps = [...opportunities].sort((a, b) => {
            const aScale = TOKEN_PROFIT_SCALE.get(a.path[0].toLowerCase()) ?? 1n;
            const bScale = TOKEN_PROFIT_SCALE.get(b.path[0].toLowerCase()) ?? 1n;
            const aValue = a.profit * bScale;
            const bValue = b.profit * aScale;
            if (bValue > aValue) return 1;
            if (bValue < aValue) return -1;
            return 0;
        });

        if (RUNTIME.debug) {
            console.log(`Processing ${sortedOpps.length} opportunities in profit order`);
        }

        for (const opp of sortedOpps) {
            // Skip if any pairs conflict
            if (!this.tryLockPairs(opp.pairs)) {
                if (RUNTIME.debug) {
                    console.log('Skipping opportunity due to pair conflict:', {
                        pairs: opp.pairs,
                        lockedPairs: Array.from(this.lockedPairs.keys())
                    });
                }
                continue;
            }

            try {
                // Execute the opportunity
                const executed = await (this.submitOpportunity
                    ? this.submitOpportunity(graph, opp)
                    : this.executeArbitrageOpportunity(graph, opp));
                if (!executed) {
                    this.releasePairs(opp.pairs);
                    continue;
                }

                if (RUNTIME.debug) {
                    console.log('Submitted opportunity:', {
                        profit: opp.profit.toString(),
                        pairs: opp.pairs
                    });
                }
            } catch (error) {
                this.releasePairs(opp.pairs);
                if (RUNTIME.debug) {
                    console.error('Failed to execute opportunity:', error);
                }
            }
        }
    }

    private async executeArbitrageOpportunity(
        graph: FlashPoolLookup,
        opportunity: ExecutableOpportunity
    ): Promise<boolean> {
        if (!CONTRACTS.arbitrage || !CONTRACTS.arbitrage.match(/^0x[a-fA-F0-9]{40}$/)) {
            throw new Error('Invalid CONTRACTS.arbitrage address');
        }

        const plan = createExecutionPlan(graph, opportunity);
        if (!plan) {
            if (RUNTIME.debug) {
                console.log('Skipping opportunity without executable plan:', {
                    path: opportunity.path,
                    pairs: opportunity.pairs,
                    protocols: opportunity.protocols,
                });
            }
            return false;
        }

        if (RUNTIME.debug) {
            console.log('Executing arbitrage:', {
                params: {
                    ...plan.params,
                    borrowAmount: plan.params.borrowAmount.toString(),
                    v2RepayFee: plan.params.v2RepayFee.toString(),
                    fees: plan.params.fees.map(fee => fee.toString()),
                },
                expectedProfit: opportunity.profit.toString()
            });
        }

        const nonce = this.nonces.reserve();
        let hash: `0x${string}`;
        try {
            hash = await this.networkConfig.walletClient.writeContract({
                address: CONTRACTS.arbitrage as Address,
                abi: ArbABI,
                functionName: 'executeArbitrage',
                args: [plan.params],
                chain: this.networkConfig.walletClient.chain,
                account: this.networkConfig.account,
                nonce,
                gas: EXECUTION_POLICY.gasLimit,
                ...(EXECUTION_POLICY.legacy
                    ? {
                        gasPrice: EXECUTION_POLICY.legacyGasPrice,
                        type: 'legacy' as const,
                    }
                    : {
                        maxFeePerGas: EXECUTION_POLICY.maxFeePerGas,
                        maxPriorityFeePerGas: EXECUTION_POLICY.maxPriorityFeePerGas,
                        type: 'eip1559' as const,
                    }),
            });
        } catch (error) {
            this.nonces.submissionFailed(nonce);
            throw error;
        }
        
        if (RUNTIME.debug) {
            console.log('Transaction sent:', {
                hash,
                nonce,
                type: 'flashswap',
            });
        }

        await sendTransactionNotification(
            hash,
            opportunity.profit,
            opportunity.path[opportunity.path.length - 1]
        );

        return true;
    }
}
