import { logger } from '../../reporting/logger';
import { type Address } from 'viem';
import { ARBITRAGE_SEARCH_POLICY, CONTRACTS } from '../../constants';
import QueryABI from '../../ABI/UniswapFlashQuery.json';
import ArbABI from '../../ABI/Arb.json';
import { V2_LIVE_POLICY } from './config';
import { estimateTransfer, type TokenTransferProfile, type TransferSample } from './transfer-fees';
import { TransferProfileStore } from './transfer-store';
import { type PairInfo } from './types';

type Result = { measured: boolean; amounts: readonly bigint[]; error: string };

// Startup/sync/background only. The search worker consumes profiles, never this client.
export type TransferProbeClient = {
  readContract(parameters: any): Promise<unknown>;
  getBlockNumber(parameters?: any): Promise<bigint>;
  getBlock(parameters: any): Promise<any>;
  simulateContract?(parameters: any): Promise<{ result: unknown }>;
};
export async function profileV2Transfers(client: TransferProbeClient, pairs: readonly PairInfo[]): Promise<PairInfo[]> {
  if (!V2_LIVE_POLICY.transferFees || pairs.length === 0) return [...pairs];
  if (ARBITRAGE_SEARCH_POLICY.allowedProtocols.some(p => p !== 'v2')) throw new Error('Transfer profiling currently supports V2-only routing. Disable V3/Carbon before enabling it.');
  if (!CONTRACTS.arbitrage || !CONTRACTS.flashQuery) throw new Error('Transfer profiling requires updated NArb and FlashQuery addresses');
  if (!client.simulateContract) throw new Error('Transfer profiling requires an eth_call simulation client');
  const policy = V2_LIVE_POLICY;
  if (!Number.isInteger(policy.transferBatchSize) || policy.transferBatchSize > 16 ||
      policy.transferBatchSize < policy.transferSampleDivisors.length || policy.transferSampleDivisors.length < 2 ||
      policy.transferSampleDivisors.some(d => d <= 1n) || !Number.isInteger(policy.transferConcurrency) ||
      policy.transferConcurrency < 1 || policy.transferConcurrency > 16 || policy.transferRefreshMs <= 0 ||
      policy.transferProbeGas < 50000 || policy.transferProbeGas > 2000000) throw new Error('Invalid V2 transfer probe bounds');
  const simulate = client.simulateContract.bind(client);
  const executor = CONTRACTS.arbitrage as Address;
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const blockHash = (await client.getBlock({ blockNumber })).hash;
  if (!blockHash) throw new Error('Transfer probe block is unavailable');
  const origin = await client.readContract({ address: executor, abi: ArbABI, functionName: 'owner', blockNumber }) as Address;
  const observedAt = Date.now();
  const store = new TransferProfileStore();
  const profiles = new Map<string, TokenTransferProfile>();
  const pending: Array<{ pair: PairInfo; token: Address; amounts: bigint[] }> = [];
  const checkedBlocks = new Map<bigint, `0x${string}` | null>([[blockNumber, blockHash]]);
  try {
    for (const pair of pairs) for (const [token, reserve] of [[pair.token0, pair.reserve0], [pair.token1, pair.reserve1]] as const) {
      const cached = store.get(executor, origin, pair.pairAddress, token);
      const key = `${pair.pairAddress.toLowerCase()}:${token.toLowerCase()}`;
      if (cached) cached.validUntil = Math.min(cached.validUntil, cached.observedAt + policy.transferRefreshMs);
      if (cached?.blockHash && cached.validUntil > observedAt) {
        if (!checkedBlocks.has(cached.blockNumber)) checkedBlocks.set(cached.blockNumber, (await client.getBlock({ blockNumber: cached.blockNumber })).hash);
        if (checkedBlocks.get(cached.blockNumber) === cached.blockHash) { profiles.set(key, cached); continue; }
      }
      const amounts = [...new Set(V2_LIVE_POLICY.transferSampleDivisors.map(divisor => reserve / divisor).filter(a => a > 1n))];
      pending.push({ pair, token, amounts });
    }
    // One token's samples stay together. Every inner probe rolls back before the next.
    const tokensPerBatch = Math.max(1, Math.floor(V2_LIVE_POLICY.transferBatchSize / V2_LIVE_POLICY.transferSampleDivisors.length));
    const runBatch = async (start: number) => {
      const batch = pending.slice(start, start + tokensPerBatch);
      const requests = batch.flatMap(p => p.amounts.map(amount => ({ pool: p.pair.pairAddress, token: p.token, amount, recipient: origin })));
      let results: readonly Result[] = [];
      if (requests.length > 0) {
        const response = await simulate({ address: CONTRACTS.flashQuery as Address, abi: QueryABI,
          functionName: 'probeV2Transfers', args: [executor, requests, BigInt(V2_LIVE_POLICY.transferProbeGas)],
          account: origin, blockNumber, gas: BigInt(requests.length * (V2_LIVE_POLICY.transferProbeGas + 40_000) + 100_000) });
        results = response.result as unknown as Result[];
        if (results.length !== requests.length) throw new Error('FlashQuery returned an incomplete transfer batch');
      }
      let offset = 0;
      for (const item of batch) {
        const samples = results.slice(offset, offset + item.amounts.length); offset += item.amounts.length;
        const leg = (index: number) => {
          const measured: TransferSample[] = samples.filter(s => s.measured)
            .map(s => ({ requested: s.amounts[index], debited: s.amounts[index + 1], credited: s.amounts[index + 2] }));
          const estimate = estimateTransfer(measured);
          return samples.some(s => !s.measured) ? { ...estimate, status: 'unknown' as const } : estimate;
        };
        const profile: TokenTransferProfile = { token: item.token, pool: item.pair.pairAddress, executor, origin, recipient: origin,
          blockNumber, blockHash, observedAt, validUntil: observedAt + V2_LIVE_POLICY.transferRefreshMs,
          probeErrors: samples.filter(s => !s.measured).map(s => s.error),
          buy: leg(0), sell: leg(3), transfer: leg(6) };
        profiles.set(`${item.pair.pairAddress.toLowerCase()}:${item.token.toLowerCase()}`, profile);
      }
      completed += batch.length;
      if (completed % 100 < batch.length || completed === pending.length) logger.info(`V2 transfer profiles: ${completed}/${pending.length} token/pool contexts`);
    };
    let next = 0, completed = 0;
    let failure: unknown;
    // Await all in-flight batches before closing SQLite, including after an RPC failure.
    await Promise.all(Array.from({ length: Math.min(policy.transferConcurrency, Math.ceil(pending.length / tokensPerBatch)) }, async () => {
      while (next < pending.length && failure === undefined) {
        const start = next; next += tokensPerBatch;
        try { await runBatch(start); } catch (error) { failure = error ?? new Error('V2 transfer batch failed'); }
      }
    }));
    if (failure !== undefined) throw failure;
    if (pending.length > 0) {
      if ((await client.getBlock({ blockNumber })).hash !== blockHash) throw new Error('Transfer probe block changed; observations were not saved');
      for (const item of pending) store.save(profiles.get(`${item.pair.pairAddress.toLowerCase()}:${item.token.toLowerCase()}`)!);
    }
    return pairs.map(pair => ({ ...pair, transferProfiles: {
      token0: profiles.get(`${pair.pairAddress.toLowerCase()}:${pair.token0.toLowerCase()}`)!,
      token1: profiles.get(`${pair.pairAddress.toLowerCase()}:${pair.token1.toLowerCase()}`)!,
    } }));
  } finally { store.close(); }
}
