import { logger } from './reporting/logger';
import { createPublicClient, http, webSocket, createWalletClient, isAddress, zeroAddress, type Account } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { NETWORK, RUNTIME, WRAPPED_NATIVE_TOKENS, TOKENS } from './constants';
import { NATIVE_TOKEN } from './tokens';

export type NetworkConfig = {
  client: ReturnType<typeof createPublicClient>;
  wsClient?: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  account: Account;
};

export function createReadClient() {
  if (!NETWORK.rpcUrl) throw new Error('RPC_URL is required');
  if (!WRAPPED_NATIVE_TOKENS.length) throw new Error('WRAPPED_NATIVE_TOKENS requires a canonical wrapper');
  for (const { address } of WRAPPED_NATIVE_TOKENS) {
    if (!isAddress(address) || address === zeroAddress || address.toLowerCase() === NATIVE_TOKEN.toLowerCase())
      throw new Error('Each WRAPPED_NATIVE_TOKENS entry must have a nonzero token address');
  }
  const addresses = new Set<string>();
  for (const { address } of [...WRAPPED_NATIVE_TOKENS, ...TOKENS]) {
    const key = address.toLowerCase();
    if (addresses.has(key)) throw new Error('Token configured more than once: ' + address);
    addresses.add(key);
  }
  return createPublicClient({
    chain: NETWORK.chain,
    transport: http(NETWORK.rpcUrl),
  });
}

export async function assertRpcChain(client: Pick<NetworkConfig['client'], 'getChainId'>): Promise<void> {
  const chainId = await client.getChainId();
  if (chainId !== NETWORK.chain.id) throw new Error(`RPC chain ${chainId} does not match NETWORK.chain.id ${NETWORK.chain.id}`);
}

export async function initializeNetwork(): Promise<NetworkConfig> {
  const client = createReadClient();
  if (!NETWORK.privateKey) throw new Error('PRIVATE_KEY is required');
  await assertRpcChain(client);

  const account = privateKeyToAccount(NETWORK.privateKey as `0x${string}`);
  const chainConfig = client.chain;

  const walletClient = createWalletClient({
    chain: chainConfig,
    transport: http(NETWORK.rpcUrl),
    account,
  });

  const config = {
    client,
    walletClient,
    account,
  };

  if (RUNTIME.websocketEnabled && NETWORK.wsUrl) {
    try {
      const wsClient = createPublicClient({
        chain: chainConfig,
        transport: webSocket(NETWORK.wsUrl),
      });
      await assertRpcChain(wsClient);
      logger.info('WebSocket client initialized successfully');
      return {
        ...config,
        wsClient,
      };
    } catch (error) {
      logger.error('Failed to initialize WebSocket client:', error);
      logger.warn('Falling back to HTTP client for events');
    }
  }

  return config;
}
