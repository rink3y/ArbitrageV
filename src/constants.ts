import { type Address } from 'viem';
import { type ArbitrageSearchPolicy } from './market-graph/types';
import { gasPrice, tokenAmount } from './values';

export type TokenConfig = {
    name: string;
    address: Address;
    liquidityAmount: bigint;
    minProfit: bigint;
    decimals: number;
};

export const NETWORK = {
    chainId: 1329,
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
    allowedProtocols: ['v2', 'v3', 'carbon'],
    allowProtocolMixing: true,
    maxRouteEdges: 5,
    beamWidth: 25,
    optimizationIterations: 32,
    maxInputReserveFraction: 10n,
    maxOpportunities: 10,
    // Live search is bounded even when discovery finds thousands of pools.
    maxCandidatesToSize: 64,
    maxSearchExpansions: 50_000,
} as const;

export const EXECUTION_POLICY = {
    executeTrades: true,
    nonceRefreshIntervalMs: 12 * 60 * 60 * 1000,
    nonceRetryIntervalMs: 5_000,
    gasLimit: 2500000n,
    legacy: false,
    legacyGasPrice: gasPrice('50.9'),
    maxFeePerGas: gasPrice('60'),
    maxPriorityFeePerGas: gasPrice('3'),
} as const;

export const RUNTIME = {
    debug: process.env.DEBUG === 'true',
    websocketEnabled: true,
    searchTimeoutMs: 10_000,
    candidateMaxAgeMs: 500,
    metricsIntervalMs: 60_000,
    notificationTimeoutMs: 5_000,
    receiptPollIntervalMs: 1_000,
    receiptTimeoutMs: 120_000,
    marketDiscoveryIntervalMs: 60_000,
} as const;

export const TELEGRAM = {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
} as const;


// dexes info
// & tokens info>
export const TOKENS: TokenConfig[] = [
    {
        name: 'WSEI',
        address: '0xE30feDd158A2e3b13e9badaeABaFc5516e95e8C7',
        liquidityAmount: tokenAmount('100'),
        minProfit: tokenAmount('0.05'),
        decimals: 18,
    },
    {
        name: 'USDC',
        address: '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392',
        liquidityAmount: tokenAmount('30', 6),
        minProfit: tokenAmount('0.09', 6),
        decimals: 6,
    },
    {
        name: 'USDC.n',
        address: '0x3894085Ef7Ff0f0aeDf52E2A2704928d1Ec074F1',
        liquidityAmount: tokenAmount('30', 6),
        minProfit: tokenAmount('0.09', 6),
        decimals: 6,
    },
    {
        name: 'USDT0',
        address: '0x9151434b16b9763660705744891fA906F660EcC5',
        liquidityAmount: tokenAmount('30', 6),
        minProfit: tokenAmount('0.09', 6),
        decimals: 6,
    },
        {
        name: 'USDT.Kava',
        address: '0xB75D0B03c06A926e488e2659DF1A861F860bD3d1',
        liquidityAmount: tokenAmount('20', 6),
        minProfit: tokenAmount('0.09', 6),
        decimals: 6,
    },
    {
        name: 'WBTC',
        address: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c',
        liquidityAmount: tokenAmount('0.0003324', 8),
        minProfit: tokenAmount('0.000001662', 8),
        decimals: 8,
    },
    {
        name: 'WETH',
        address: '0x160345fC359604fC6e70E3c5fAcbdE5F7A9342d8',
        liquidityAmount: tokenAmount('0.01238'),
        minProfit: tokenAmount('0.00006190'),
        decimals: 18,
    },
        {
        name: 'DRG',
        address: '0x0a526e425809aEA71eb279d24ae22Dee6C92A4Fe',
        liquidityAmount: tokenAmount('2100'),
        minProfit: tokenAmount('10.50'),
        decimals: 18,
    },
    {
        name: 'ISEI',
        address: '0x5Cf6826140C1C56Ff49C808A1A75407Cd1DF9423',
        liquidityAmount: tokenAmount('668'),
        minProfit: tokenAmount('3.34'),
        decimals: 18,
    },
    {
        name: 'SEIYAN',
        address: '0x5f0E07dFeE5832Faa00c63F2D33A0D79150E8598',
        liquidityAmount: tokenAmount('128820', 6),
        minProfit: tokenAmount('644', 6),
        decimals: 6,
    }
];
