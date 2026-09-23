import { createPublicClient, http, webSocket, createWalletClient, type Account } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sei } from 'viem/chains';
import { NETWORK, RUNTIME } from './constants';

export type NetworkConfig = {
  client: ReturnType<typeof createPublicClient>;
  wsClient?: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  account: Account;
};

export function createReadClient() {
  if (!NETWORK.rpcUrl) throw new Error('RPC_URL is required');
  return createPublicClient({
    chain: { ...sei, id: NETWORK.chainId },
    transport: http(NETWORK.rpcUrl),
  });
}

export async function initializeNetwork(): Promise<NetworkConfig> {
  const client = createReadClient();
  if (!NETWORK.privateKey) throw new Error('PRIVATE_KEY is required');

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
