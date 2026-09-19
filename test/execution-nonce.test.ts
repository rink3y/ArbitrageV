import { expect, mock, spyOn, test } from 'bun:test';
import { createPublicClient, createWalletClient, custom, parseTransaction, type Hex } from 'viem';
import { sei } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { CONTRACTS, NETWORK, TELEGRAM } from '../src/constants';
import { OpportunityManager } from '../src/execute';
import { type ExecutableOpportunity, type FlashPoolLookup } from '../src/execution/execution-planner';
import { initializeNetwork, type NetworkConfig } from '../src/network';

test('a stalled notification does not hold up another submission', async () => {
  const previousContract = CONTRACTS.arbitrage;
  const previousTelegram = { ...TELEGRAM };
  const token = '0x0000000000000000000000000000000000000001';
  Object.assign(CONTRACTS, { arbitrage: token });
  Object.assign(TELEGRAM, { botToken: 'test-token', chatId: 'test-chat' });
  let release!: (response: Response) => void;
  const notify = spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(resolve => { release = resolve; }));
  let submissions = 0;
  const manager = new OpportunityManager({ account: privateKeyToAccount(`0x${'1'.padStart(64, '0')}`),
    client: { getTransactionCount: async () => 7 },
    walletClient: { sendRawTransaction: async () => `0x${(++submissions).toString(16).padStart(64, '0')}` },
  } as unknown as NetworkConfig);
  const lookup: FlashPoolLookup = { findBestFlashPoolForToken: () => ({ protocol: 'v2', poolAddress: token, fee: 30, liquidity: 1000n }) };
  const opportunity: ExecutableOpportunity = { path: [token, token], pairs: [token], protocols: ['v2'], fees: [30], routeData: ['0x'], optimalInput: 1n, profit: 1n };
  try {
    await manager.start();
    await manager.processOpportunities(lookup, [opportunity]);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(notify).toHaveBeenCalledTimes(1);
    manager.releasePairs([token]);
    await manager.processOpportunities(lookup, [opportunity]);
    expect(submissions).toBe(2);
    expect(notify).toHaveBeenCalledTimes(1);
  } finally {
    manager.stop(); release?.(new Response('{}')); notify.mockRestore();
    Object.assign(CONTRACTS, { arbitrage: previousContract }); Object.assign(TELEGRAM, previousTelegram);
  }
});

test('a market change during signing prevents broadcast and returns only the unsubmitted nonce', async () => {
  const previousContract = CONTRACTS.arbitrage;
  const token = '0x0000000000000000000000000000000000000001';
  Object.assign(CONTRACTS, { arbitrage: token });
  const account = privateKeyToAccount(`0x${'1'.padStart(64, '0')}`);
  const sign = account.signTransaction.bind(account);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let hold = true;
  account.signTransaction = async (...args) => {
    if (hold) { entered(); await gate; }
    return sign(...args);
  };
  let fresh = true;
  let nonceReads = 0;
  const submitted: number[] = [];
  const transport = custom({ async request({ method, params }) {
    if (method === 'eth_chainId') return '0x531';
    if (method === 'eth_getTransactionCount') { nonceReads++; return '0x7'; }
    if (method === 'eth_sendRawTransaction') {
      submitted.push(parseTransaction((params as Hex[])[0]).nonce!);
      return `0x${'0'.repeat(64)}`;
    }
    throw new Error('Unexpected RPC ' + method);
  } });
  const manager = new OpportunityManager({ account,
    client: createPublicClient({ chain: sei, transport }), walletClient: createWalletClient({ account, chain: sei, transport }) });
  const lookup: FlashPoolLookup = {
    matchesVersions: () => fresh,
    findBestFlashPoolForToken: () => ({ protocol: 'v2', poolAddress: token, fee: 30, liquidity: 1000n }),
  };
  const opportunity: ExecutableOpportunity = { path: [token, token], pairs: [token], protocols: ['v2'], fees: [30],
    routeData: ['0x'], optimalInput: 1n, profit: 1n, marketVersions: { [token]: 1 } };
  try {
    await manager.start();
    const first = manager.processOpportunities(lookup, [opportunity]);
    await started;
    fresh = false;
    release();
    await first;
    expect(submitted).toEqual([]);
    expect(nonceReads).toBe(1);
    fresh = true;
    hold = false;
    await manager.processOpportunities(lookup, [opportunity]);
    expect(submitted).toEqual([7]);
    expect(nonceReads).toBe(1);
  } finally {
    release(); manager.stop();
    Object.assign(CONTRACTS, { arbitrage: previousContract });
  }
});

test('execution warms once and submits concurrent and later trades without nonce RPC reads', async () => {
  const previousNetwork = { ...NETWORK };
  const previousContract = CONTRACTS.arbitrage;
  const previousTelegram = TELEGRAM.botToken;
  const token = '0x0000000000000000000000000000000000000001';
  const firstPool = '0x0000000000000000000000000000000000000002';
  const secondPool = '0x0000000000000000000000000000000000000003';
  const nonces: number[] = [];
  const nonceBlocks: unknown[] = [];
  const methods: string[] = [];
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
        methods.push(method);
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
    expect(methods).toEqual(['eth_getTransactionCount']);
    await Promise.all([
      manager.processOpportunities(lookup, [opportunity]),
      manager.processOpportunities(lookup, [{ ...opportunity, pairs: [secondPool] }]),
    ]);
    expect(nonces.sort((a, b) => a - b)).toEqual([7, 8]);
    manager.releasePairs([firstPool]);
    await manager.processOpportunities(lookup, [opportunity]);
    expect(nonces).toEqual([7, 8, 9]);
    expect(methods).toEqual(['eth_getTransactionCount', 'eth_sendRawTransaction', 'eth_sendRawTransaction', 'eth_sendRawTransaction']);
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
    const write = mock((request: { serializedTransaction: Hex }) => {
      submitted.push(parseTransaction(request.serializedTransaction).nonce!);
      if (submitted.length === 1) {
        if (synchronous) throw new Error('submission failed');
        return Promise.reject(new Error('submission timed out'));
      }
      return Promise.resolve(`0x${'0'.repeat(64)}`);
    });
    const manager = new OpportunityManager({
      account: privateKeyToAccount(`0x${'1'.padStart(64, '0')}`),
      client: { getTransactionCount: read },
      walletClient: { sendRawTransaction: write },
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
