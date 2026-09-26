import { type Address, type Chain } from 'viem';
import { cronos } from 'viem/chains';
import { type ArbitrageSearchPolicy } from './market-graph/types';
import { gasPrice, tokenAmount } from './values';

export type TokenConfig = {
    name: string;
    address: Address;
    liquidityAmount: bigint;
    // Native wei, independent of this token's decimals.
    minProfitNative?: bigint;
    decimals: number;
};

export const NETWORK = {
    chain: cronos as Chain,
    rpcUrl: process.env.RPC_URL,
    wsUrl: process.env.WSS_URL,
    privateKey: process.env.PRIVATE_KEY,
} as const;

export const CONTRACTS = {
    arbitrage: process.env.ARB_CONTRACT_ADDRESS,
    flashQuery: process.env.UNISWAP_FLASH_QUERY_CONTRACT_ADDRESS,
} as const;

// WETH9-compatible wrappers of the SAME native coin, not bridged ETH/BTC.
// First entry is the canonical wrapper and must match the NArb constructor.
// Additional entries must also be approved with NArb.setWrapper after deployment.
export const WRAPPED_NATIVE_TOKENS: [TokenConfig, ...TokenConfig[]] = [
    {
        name: 'WCRO',
        address: '0x5C7F8A570d578ED84E63fdFA7b1eE72dEae1AE23',
        liquidityAmount: tokenAmount('100'),
        decimals: 18,
    },
    {
        name: 'WCRO',
        address: '0xca2503482e5D6D762b524978f400f03E38d5F962',
        liquidityAmount: tokenAmount('100'),
        decimals: 18,
    },
];

export const ARBITRAGE_SEARCH_POLICY: ArbitrageSearchPolicy = {
    topTokens: 3,
    minProfitNative: tokenAmount('0.09'),
    tokenSelectionRefreshMs: 24 * 60 * 60 * 1000,
    // Controls discovery, live loading, event monitoring, and route searches. Use ['v2'] for V2 only.
    allowedProtocols: ['v2'],
    allowProtocolMixing: true,
    maxRouteEdges: 5,
    beamWidth: 25,
    optimizationIterations: 32,
    maxInputReserveFraction: 10n,
    maxOpportunities: 10,
    // Live search is bounded even when discovery finds thousands of pools.
    maxCandidatesToSize: 64,
    maxSearchExpansions: 50_000,
    // Enables split search. executeTrades controls submission for all routes.
    splitRouting: 'live', // 'off' | 'live'
    splitSearchMs: 10,
} as const;

export const EXECUTION_POLICY = {
    executeTrades: true,
    // First V2/V3 swap supplies the output before callback repayment. Requires the modular NArb.
    routeSwapFunding: false,
    // Batch combines independent quotes; separate sends a predicted follow-up.
    submissionMode: 'single' as 'single' | 'separate' | 'batch',
    followUpSearchMs: 10,
    nonceRefreshIntervalMs: 12 * 60 * 60 * 1000,
    nonceRetryIntervalMs: 5_000,
    gasLimits: {
        single: 1_500_000n, // Direct, split, or each separately submitted follow-up.
        batch: 3_000_000n, // Total allowance for independent attempts, including failed ones.
    },
    // Haircut on each split branch's quoted output, used to fund the next stage.
    slippageBps: 5,
    // Fees refresh away from the submission path. The last valid quote keeps its original expiry.
    feeRefreshIntervalMs: 5 * 60 * 1000,
    // Applies to legacy gasPrice or EIP-1559 maxFeePerGas; never clamps estimates.
    feeCeilingPerGas: gasPrice('1000'),
    legacy: true,
} as const;

export const RUNTIME: {
    logLevel: 'off' | 'info' | 'debug';
    websocketEnabled: boolean;
    searchTimeoutMs: number;
    candidateMaxAgeMs: number;
    metricsIntervalMs: number;
    notificationTimeoutMs: number;
    reportingShutdownMs: number;
    marketDiscoveryIntervalMs: number;
} = {
    logLevel: 'off', // 'off' | 'info' | 'debug'
    websocketEnabled: true,
    searchTimeoutMs: 10_000,
    candidateMaxAgeMs: 500,
    metricsIntervalMs: 60_000,
    notificationTimeoutMs: 5_000,
    reportingShutdownMs: 2_000,
    marketDiscoveryIntervalMs: 4 * 60 * 60 * 1000,
};

export const TELEGRAM = {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
} as const;


// Ordinary tokens only. Native wrappers above are included automatically.
export const TOKENS: TokenConfig[] = [
    {
        name: 'VVS',
        address: '0x2D03bECE6747ADC00E1a131BBA1469C15fD11e03',
        liquidityAmount: tokenAmount('1000000', 18),
        decimals: 18,
    },
    {
        name: 'USDC.e',
        address: '0xc21223249CA28397B4B6541dfFaEcC539BfF0c59',
        liquidityAmount: tokenAmount('10', 6),
        decimals: 6,
    },
    {
        name: 'USDT',
        address: '0x66e428c3f67a68878562e79A0234c1F83c208770',
        liquidityAmount: tokenAmount('10', 6),
        decimals: 6,
    },
    {
        name: 'WBTC',
        address: '0x062E66477Faf219F25D27dCED647BF57C3107d52',
        liquidityAmount: tokenAmount('0.0001196', 8),
        decimals: 8,
    },
    {
        name: 'WETH',
        address: '0xe44Fd7fCb2b1581822D0c862B68222998a0c299a',
        liquidityAmount: tokenAmount('0.003782', 18),
        decimals: 18,
    },
    {
        name: 'USC',
        address: '0xD42E078ceA2bE8D03cd9dFEcC1f0d28915Edea78',
        liquidityAmount: tokenAmount('10', 18),
        decimals: 18,
    },
    {
        name: 'USDC',
        address: '0x3D7F2C478aAfdB65542BCB44bCeeC05849999d2D',
        liquidityAmount: tokenAmount('10', 6),
        decimals: 6,
    },
    // {
    //     name: 'SEIYAN',
    //     address: '0x5f0E07dFeE5832Faa00c63F2D33A0D79150E8598',
    //     liquidityAmount: tokenAmount('128820', 6),
    //     decimals: 6,
    // }
];

// Derived once at startup. Wrapper entries get the first preferred-start slots.
export const CONFIGURED_TOKENS: readonly TokenConfig[] = [...WRAPPED_NATIVE_TOKENS, ...TOKENS];
