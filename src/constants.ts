import { type Address, type Chain } from 'viem';
import { cronos } from 'viem/chains';
import { type ArbitrageSearchPolicy } from './market-graph/types';
import { gasPrice, tokenAmount } from './values';

export type TokenConfig = {
    name: string;
    address: Address;
    liquidityAmount: bigint;
    minProfit: bigint;
    decimals: number;
    // Smallest token units per native wei. Non-native split profits need a fresh rate.
    gasConversion?: { numerator: bigint; denominator: bigint; validUntil: number };
};

export const NETWORK = {
    chain: cronos as Chain,
    wrappedNativeToken: '0x5C7F8A570d578ED84E63fdFA7b1eE72dEae1AE23' as Address,
    rpcUrl: process.env.RPC_URL,
    wsUrl: process.env.WSS_URL,
    privateKey: process.env.PRIVATE_KEY,
} as const;

export const CONTRACTS = {
    arbitrage: process.env.ARB_CONTRACT_ADDRESS,
    flashQuery: process.env.UNISWAP_FLASH_QUERY_CONTRACT_ADDRESS,
} as const;

export const ARBITRAGE_SEARCH_POLICY: ArbitrageSearchPolicy = {
    topTokens: 10,
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
    // Shadow reports splits without submitting them; linear trading is unaffected.
    splitRouting: 'shadow', // 'off' | 'shadow' | 'live'
    splitSearchMs: 10,
} as const;

export const EXECUTION_POLICY = {
    executeTrades: false,
    nonceRefreshIntervalMs: 12 * 60 * 60 * 1000,
    nonceRetryIntervalMs: 5_000,
    gasLimit: 2500000n,
    // Split-output haircut and maximum haircut on quoted linear surplus.
    slippageBps: 5,
    // Fees refresh away from the submission path. A failed refresh pauses trading.
    feeRefreshIntervalMs: 5 * 60 * 1000,
    // Applies to legacy gasPrice or EIP-1559 maxFeePerGas; never clamps estimates.
    feeCeilingPerGas: gasPrice('1000'),
    legacy: false,
} as const;

export const RUNTIME: {
    logLevel: 'off' | 'info' | 'debug';
    websocketEnabled: boolean;
    searchTimeoutMs: number;
    candidateMaxAgeMs: number;
    metricsIntervalMs: number;
    notificationTimeoutMs: number;
    reportingShutdownMs: number;
    receiptPollIntervalMs: number;
    receiptTimeoutMs: number;
    marketDiscoveryIntervalMs: number;
} = {
    logLevel: 'info', // 'off' | 'info' | 'debug'
    websocketEnabled: true,
    searchTimeoutMs: 10_000,
    candidateMaxAgeMs: 500,
    metricsIntervalMs: 60_000,
    notificationTimeoutMs: 5_000,
    reportingShutdownMs: 2_000,
    receiptPollIntervalMs: 1_000,
    receiptTimeoutMs: 120_000,
    marketDiscoveryIntervalMs: 60_000,
};

export const TELEGRAM = {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
} as const;


export const TOKENS: TokenConfig[] = [
    {
        name: 'WCRO',
        address: '0x5C7F8A570d578ED84E63fdFA7b1eE72dEae1AE23',
        liquidityAmount: tokenAmount('100'),
        minProfit: tokenAmount('0.09'),
        decimals: 18,
    },
    {
        name: 'WCRO1',
        address: '0xca2503482e5D6D762b524978f400f03E38d5F962',
        liquidityAmount: tokenAmount('100'),
        minProfit: tokenAmount('0.09'),
        decimals: 18,
    },
    {
        name: 'USDC.e',
        address: '0xc21223249CA28397B4B6541dfFaEcC539BfF0c59',
        liquidityAmount: tokenAmount('10', 6),
        minProfit: tokenAmount('0.10', 6),
        decimals: 6,
    },
    {
        name: 'USDC',
        address: '0x3D7F2C478aAfdB65542BCB44bCeeC05849999d2D',
        liquidityAmount: tokenAmount('10', 6),
        minProfit: tokenAmount('0.10', 6),
        decimals: 6,
    },
    {
        name: 'USDT',
        address: '0x66e428c3f67a68878562e79A0234c1F83c208770',
        liquidityAmount: tokenAmount('10', 6),
        minProfit: tokenAmount('0.10', 6),
        decimals: 6,
    },
        {
        name: 'VVS',
        address: '0x2D03bECE6747ADC00E1a131BBA1469C15fD11e03',
        liquidityAmount: tokenAmount('1000000', 18),
        minProfit: tokenAmount('99000', 18),
        decimals: 18,
    },
    {
        name: 'WBTC',
        address: '0x062E66477Faf219F25D27dCED647BF57C3107d52',
        liquidityAmount: tokenAmount('0.0001196', 8),
        minProfit: tokenAmount('0.000001196', 8),
        decimals: 8,
    },
    {
        name: 'WETH',
        address: '0xe44Fd7fCb2b1581822D0c862B68222998a0c299a',
        liquidityAmount: tokenAmount('0.003782', 18),
        minProfit: tokenAmount('0.00003782', 18),
        decimals: 18,
    },
        {
        name: 'USC',
        address: '0xD42E078ceA2bE8D03cd9dFEcC1f0d28915Edea78',
        liquidityAmount: tokenAmount('10', 18),
        minProfit: tokenAmount('0.10', 18),
        decimals: 18,
    },
    // {
    //     name: 'ISEI',
    //     address: '0x5Cf6826140C1C56Ff49C808A1A75407Cd1DF9423',
    //     liquidityAmount: tokenAmount('668'),
    //     minProfit: tokenAmount('3.34'),
    //     decimals: 18,
    // },
    // {
    //     name: 'SEIYAN',
    //     address: '0x5f0E07dFeE5832Faa00c63F2D33A0D79150E8598',
    //     liquidityAmount: tokenAmount('128820', 6),
    //     minProfit: tokenAmount('644', 6),
    //     decimals: 6,
    // }
];
