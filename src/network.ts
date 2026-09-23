import { createPublicClient, http, webSocket, createWalletClient, isAddress, zeroAddress, type Account } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { NETWORK, RUNTIME } from './constants';
import { NATIVE_TOKEN } from './tokens';

export type NetworkConfig = {
  client: ReturnType<typeof createPublicClient>;
  wsClient?: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  account: Account;
};

export function createReadClient() {
  if (!NETWORK.rpcUrl) throw new Error('RPC_URL is required');
  if (!isAddress(NETWORK.wrappedNativeToken) || NETWORK.wrappedNativeToken === zeroAddress ||
      NETWORK.wrappedNativeToken.toLowerCase() === NATIVE_TOKEN.toLowerCase()) {
    throw new Error('NETWORK.wrappedNativeToken must be a nonzero token address');
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
      console.log('WebSocket client initialized successfully');
      return {
        ...config,
        wsClient,
      };
    } catch (error) {
      console.error('Failed to initialize WebSocket client:', error);
      console.warn('Falling back to HTTP client for events');
    }
  }

  return config;
}
