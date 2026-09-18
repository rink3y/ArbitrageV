import { expect, mock, spyOn, test } from 'bun:test';
import { createPublicClient, createWalletClient, custom, parseTransaction, type Hex } from 'viem';
import { sei } from 'viem/chains';
import { CONTRACTS, NETWORK, TELEGRAM } from '../src/constants';
import { OpportunityManager } from '../src/execute';
import { type ExecutableOpportunity, type FlashPoolLookup } from '../src/execution/execution-planner';
import { initializeNetwork, type NetworkConfig } from '../src/network';

test('execution warms once and submits concurrent and later trades without nonce RPC reads', async () => {
  const previousNetwork = { ...NETWORK };
  const previousContract = CONTRACTS.arbitrage;
  const previousTelegram = TELEGRAM.botToken;
  const token = '0x0000000000000000000000000000000000000001';
  const firstPool = '0x0000000000000000000000000000000000000002';
  const secondPool = '0x0000000000000000000000000000000000000003';
  const nonces: number[] = [];
  const nonceBlocks: unknown[] = [];
  let manager: OpportunityManager | undefined;

  Object.assign(NETWORK, {
    rpcUrl: 'http://127.0.0.1:1', wsUrl: undefined,
    // Public test key. The transport below never sends signed transactions to a node.
    privateKey: `0x${'1'.padStart(64, '0')}`,
  });
  Object.assign(CONTRACTS, { arbitrage: token });
  Object.assign(TELEGRAM, { botToken: '' });
  try {
    const network = await initializeNetwork();
    expect(network.account.type).toBe('local');
    if (network.account.type !== 'local') throw new Error('Expected a local signing account');
    expect(network.account.nonceManager).toBeUndefined();
    const transport = custom({
      async request({ method, params }) {
        if (method === 'eth_chainId') return '0x531';
        if (method === 'eth_getTransactionCount') {
          nonceBlocks.push((params as unknown[])[1]);
          return '0x7';
        }
        if (method === 'eth_sendRawTransaction') {
          nonces.push(parseTransaction((params as Hex[])[0]).nonce!);
          return `0x${'0'.repeat(64)}`;
        }
        throw new Error(`Unexpected RPC method: ${method}`);
      },
    });
    network.client = createPublicClient({ chain: sei, transport });
    network.walletClient = createWalletClient({ account: network.account, chain: sei, transport });
    const lookup: FlashPoolLookup = {
      findBestFlashPoolForToken: () => ({ protocol: 'v2', poolAddress: token, fee: 30, liquidity: 1_000n }),
    };
    const opportunity: ExecutableOpportunity = {
      path: [token, token], pairs: [firstPool], protocols: ['v2'], fees: [30],
      routeData: ['0x'], optimalInput: 1n, profit: 1n,
    };
    manager = new OpportunityManager(network);
    await manager.start();
    expect(nonceBlocks).toEqual(['pending']);
    await Promise.all([
      manager.processOpportunities(lookup, [opportunity]),
      manager.processOpportunities(lookup, [{ ...opportunity, pairs: [secondPool] }]),
    ]);
    expect(nonces.sort((a, b) => a - b)).toEqual([7, 8]);
    manager.releasePairs([firstPool]);
    await manager.processOpportunities(lookup, [opportunity]);
    expect(nonces).toEqual([7, 8, 9]);
    expect(nonceBlocks).toEqual(['pending']);
  } finally {
    manager?.stop();
    Object.assign(NETWORK, previousNetwork);
    Object.assign(CONTRACTS, { arbitrage: previousContract });
    Object.assign(TELEGRAM, { botToken: previousTelegram });
  }
});

for (const synchronous of [false, true]) {
  test(`submission ${synchronous ? 'throws' : 'rejects'}: refreshes immediately and blocks nonce reuse`, async () => {
    const previousContract = CONTRACTS.arbitrage;
    const previousTelegram = TELEGRAM.botToken;
    const token = '0x0000000000000000000000000000000000000001';
    const errorLog = spyOn(console, 'error').mockImplementation(() => {});
    const debugLog = spyOn(console, 'log').mockImplementation(() => {});
    let resolvePending!: (value: number) => void;
    const read = mock(() => Promise.resolve(7));
    const submitted: number[] = [];
    const write = mock((request: { nonce: number }) => {
      submitted.push(request.nonce);
      if (submitted.length === 1) {
        if (synchronous) throw new Error('submission failed');
        return Promise.reject(new Error('submission timed out'));
      }
      return Promise.resolve(`0x${'0'.repeat(64)}`);
    });
    const manager = new OpportunityManager({
      account: { address: token },
      client: { getTransactionCount: read },
      walletClient: { writeContract: write },
    } as unknown as NetworkConfig);
    Object.assign(CONTRACTS, { arbitrage: token });
    Object.assign(TELEGRAM, { botToken: '' });
    try {
      await manager.start();
      read.mockImplementation(() => new Promise<number>(resolve => { resolvePending = resolve; }));
      const lookup: FlashPoolLookup = {
        findBestFlashPoolForToken: () => ({ protocol: 'v2', poolAddress: token, fee: 30, liquidity: 1_000n }),
      };
      const opportunity: ExecutableOpportunity = {
        path: [token, token], pairs: [token], protocols: ['v2'], fees: [30],
        routeData: ['0x'], optimalInput: 1n, profit: 1n,
      };
      await manager.processOpportunities(lookup, [opportunity]);
      expect(read).toHaveBeenCalledTimes(2);
      await manager.processOpportunities(lookup, [opportunity]);
      expect(submitted).toEqual([7]);
      resolvePending(8);
      await Bun.sleep(1);
      await manager.processOpportunities(lookup, [opportunity]);
      expect(submitted).toEqual([7, 8]);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      manager.stop();
      Object.assign(CONTRACTS, { arbitrage: previousContract });
      Object.assign(TELEGRAM, { botToken: previousTelegram });
      errorLog.mockRestore();
      debugLog.mockRestore();
    }
  });
}
