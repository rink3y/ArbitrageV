import { expect, mock, spyOn, test } from 'bun:test';
import { createPublicClient, createWalletClient, custom, parseTransaction, type Hex } from 'viem';
import { sei } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { CONTRACTS, NETWORK, TELEGRAM } from '../src/constants';
import { OpportunityManager } from '../src/execute';
import { type ExecutableOpportunity, type FlashPoolLookup } from '../src/execution/execution-planner';
import { initializeNetwork, type NetworkConfig } from '../src/network';
import { startedTestGasFees } from './helpers/gas-fees';
import { logger } from '../src/reporting/logger';
import { formatAlert } from '../src/reporting/telegram';

for (const explorer of ['https://explorer.invalid/', undefined]) {
test(`notifications use the configured explorer ${explorer ?? 'or no link'} without holding up submissions`, async () => {
  const previousChain = NETWORK.chain;
  const previousContract = CONTRACTS.arbitrage;
  const previousTelegram = { ...TELEGRAM };
  const token = '0x0000000000000000000000000000000000000001';
  Object.assign(CONTRACTS, { arbitrage: token });
  Object.assign(TELEGRAM, { botToken: 'test-token', chatId: 'test-chat' });
  Object.assign(NETWORK, { chain: { ...previousChain,
    blockExplorers: explorer ? { default: { name: 'Test explorer', url: explorer } } : undefined,
  } });
  let text = '';
  const notify = spyOn(logger, 'alert').mockImplementation((_key, level, ...args) => {
    text = formatAlert({ at: 0, level, args }, { ...TELEGRAM, timeoutMs: 1, explorer });
  });
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Execution must not send Telegram directly'); });
  let submissions = 0;
  const gasFees = await startedTestGasFees();
  const manager = new OpportunityManager({ account: privateKeyToAccount(`0x${'1'.padStart(64, '0')}`),
    client: { getTransactionCount: async () => 7 },
    walletClient: { sendRawTransaction: async () => `0x${(++submissions).toString(16).padStart(64, '0')}` },
  } as unknown as NetworkConfig, undefined, gasFees);
  const lookup: FlashPoolLookup = { findBestFlashPoolForToken: () => ({ protocol: 'v2', poolAddress: token, fee: 30, liquidity: 1000n }) };
  const opportunity: ExecutableOpportunity = { path: [token, token], pairs: [token], protocols: ['v2'], fees: [30], routeData: ['0x'], optimalInput: 1n, profit: 1n };
  try {
    await manager.start();
    await manager.processOpportunities(lookup, [opportunity]);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(notify).toHaveBeenCalledTimes(1);
    if (explorer) expect(text).toContain('https://explorer.invalid/tx/0x');
    else expect(text).not.toContain('https://');
    manager.releasePairs([token]);
    await manager.processOpportunities(lookup, [opportunity]);
    expect(submissions).toBe(2);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    manager.stop(); notify.mockRestore(); fetchSpy.mockRestore();
    Object.assign(NETWORK, { chain: previousChain });
    Object.assign(CONTRACTS, { arbitrage: previousContract }); Object.assign(TELEGRAM, previousTelegram);
  }
});
}

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
  const gasFees = await startedTestGasFees();
  const manager = new OpportunityManager({ account,
    client: createPublicClient({ chain: sei, transport }), walletClient: createWalletClient({ account, chain: sei, transport }) },
    undefined, gasFees);
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
    chain: { id: 31337, name: 'Offline chain', nativeCurrency: { name: 'Test', symbol: 'TEST', decimals: 18 },
      rpcUrls: { default: { http: ['http://127.0.0.1:1'] } } },
    // Public test key. The transport below never sends signed transactions to a node.
    privateKey: `0x${'1'.padStart(64, '0')}`,
  });
  Object.assign(CONTRACTS, { arbitrage: token });
  Object.assign(TELEGRAM, { botToken: '' });
  const rpc = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
    jsonrpc: '2.0', id: 0, result: `0x${NETWORK.chain.id.toString(16)}`,
  }), { headers: { 'content-type': 'application/json' } }));
  try {
    const network = await initializeNetwork();
    rpc.mockRestore();
    expect(network.client.chain?.id).toBe(31337);
    expect(network.walletClient.chain?.id).toBe(31337);
    expect(network.account.type).toBe('local');
    if (network.account.type !== 'local') throw new Error('Expected a local signing account');
    expect(network.account.nonceManager).toBeUndefined();
    const transport = custom({
      async request({ method, params }) {
        methods.push(method);
        if (method === 'eth_chainId') return '0x7a69';
        if (method === 'eth_getTransactionCount') {
          nonceBlocks.push((params as unknown[])[1]);
          return '0x7';
        }
        if (method === 'eth_sendRawTransaction') {
          expect(parseTransaction((params as Hex[])[0]).chainId).toBe(31337);
          nonces.push(parseTransaction((params as Hex[])[0]).nonce!);
          return `0x${'0'.repeat(64)}`;
        }
        throw new Error(`Unexpected RPC method: ${method}`);
      },
    });
    network.client = createPublicClient({ chain: NETWORK.chain, transport });
    network.walletClient = createWalletClient({ account: network.account, chain: NETWORK.chain, transport });
    const lookup: FlashPoolLookup = {
      findBestFlashPoolForToken: () => ({ protocol: 'v2', poolAddress: token, fee: 30, liquidity: 1_000n }),
    };
    const opportunity: ExecutableOpportunity = {
      path: [token, token], pairs: [firstPool], protocols: ['v2'], fees: [30],
      routeData: ['0x'], optimalInput: 1n, profit: 1n,
    };
    const gasFees = await startedTestGasFees();
    manager = new OpportunityManager(network, undefined, gasFees);
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
    rpc.mockRestore();
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
    const gasFees = await startedTestGasFees();
    const manager = new OpportunityManager({
      account: privateKeyToAccount(`0x${'1'.padStart(64, '0')}`),
      client: { getTransactionCount: read },
      walletClient: { sendRawTransaction: write },
    } as unknown as NetworkConfig, undefined, gasFees);
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
