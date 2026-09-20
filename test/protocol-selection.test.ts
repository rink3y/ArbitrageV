import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { ARBITRAGE_SEARCH_POLICY, CONTRACTS, NETWORK } from '../src/constants';
import * as marketDb from '../src/market-db';
import * as network from '../src/network';
import * as workflow from '../src/opportunities/opportunity-workflow';
import { protocolPlugin } from '../src/protocols/registry';
import { runArbitrageBot } from '../src/runtime/arbitrage-bot';
import { parseSyncProtocols, syncMarkets } from '../src/sync-markets';

const previousProtocols = ARBITRAGE_SEARCH_POLICY.allowedProtocols;
const previousSigintListeners = new Set(process.listeners('SIGINT'));
const token0 = '0x0000000000000000000000000000000000000001';
const token1 = '0x0000000000000000000000000000000000000002';
const v2Address = '0x0000000000000000000000000000000000000003';

afterEach(() => {
  ARBITRAGE_SEARCH_POLICY.allowedProtocols = previousProtocols;
  mock.restore();
  for (const listener of process.listeners('SIGINT')) {
    if (!previousSigintListeners.has(listener)) process.removeListener('SIGINT', listener);
  }
});

function prepareRuntime() {
  ARBITRAGE_SEARCH_POLICY.allowedProtocols = ['v2'];
  const catalog: marketDb.MarketSnapshot = {
    v2Pools: [{
      pairAddress: v2Address, token0, token1, factory: 'test', fee: 30,
      variant: 'uniswap-v2', scale0: 1n, scale1: 1n,
    }],
    v3Pools: [{
      name: 'cached-v3', address: '0x0000000000000000000000000000000000000004',
      token0, token1, fee: 3000, tickSpacing: 60, enabled: true,
    }],
    carbonPairs: [{
      controller: '0x0000000000000000000000000000000000000005',
      token0, token1, strategyCount: 1, feePpm: 4000,
    }],
  };
  const watch = mock((_parameters: unknown) => () => {});
  const initialize = spyOn(network, 'initializeNetwork').mockResolvedValue({
    client: { watchContractEvent: watch, getBlockNumber: async () => 10n },
  } as unknown as network.NetworkConfig);
  spyOn(marketDb, 'loadMarketSnapshot').mockReturnValue(catalog);
  const scan = mock(async () => []);
  const stop = mock(() => {});
  const scanner = spyOn(workflow, 'createOpportunityScanner').mockResolvedValue({ scan, stop, warm: async () => {} });
  const v2Hydrate = spyOn(protocolPlugin('v2'), 'hydrate').mockResolvedValue();
  const disabled = ['v3', 'carbon'].map(id => {
    const plugin = protocolPlugin(id as 'v3' | 'carbon');
    return {
      hydrate: spyOn(plugin, 'hydrate').mockResolvedValue(),
      events: spyOn(plugin, 'events').mockReturnValue(null),
    };
  });
  spyOn(console, 'log').mockImplementation(() => {});
  return { catalog, watch, initialize, scan, scanner, stop, v2Hydrate, disabled };
}

test('startup stops nonce refresh when event adapter creation fails', async () => {
  const { stop } = prepareRuntime();
  spyOn(protocolPlugin('v2'), 'events').mockImplementation(() => { throw new Error('adapter failed'); });
  await expect(runArbitrageBot()).rejects.toThrow('adapter failed');
  expect(stop).toHaveBeenCalledTimes(1);
});

test('startup stops nonce refresh when market hydration fails', async () => {
  const { stop, v2Hydrate } = prepareRuntime();
  v2Hydrate.mockRejectedValue(new Error('hydration failed'));
  await expect(runArbitrageBot()).rejects.toThrow('hydration failed');
  expect(stop).toHaveBeenCalledTimes(1);
});

test('V2-only startup skips cached V3 and Carbon hydration and event subscriptions', async () => {
  const { watch, scan, scanner, v2Hydrate, disabled } = prepareRuntime();
  await runArbitrageBot();

  expect(v2Hydrate).toHaveBeenCalledTimes(1);
  for (const plugin of disabled) {
    expect(plugin.hydrate).not.toHaveBeenCalled();
    expect(plugin.events).not.toHaveBeenCalled();
  }
  expect(watch).toHaveBeenCalledTimes(1);
  expect(watch.mock.calls[0]).toEqual([expect.objectContaining({ address: [v2Address] })]);
  expect(scanner.mock.calls[0][0].graph.getV3PoolAddresses()).toEqual([]);
  expect(scan).toHaveBeenCalledTimes(1);
});

test('cached disabled markets do not satisfy the startup market check', async () => {
  const { catalog, watch, v2Hydrate } = prepareRuntime();
  catalog.v2Pools = [];
  await expect(runArbitrageBot()).rejects.toThrow('No markets for enabled protocols');
  expect(watch).not.toHaveBeenCalled();
  expect(v2Hydrate).not.toHaveBeenCalled();
});

test('empty protocol configuration fails before network initialization', async () => {
  const { initialize } = prepareRuntime();
  ARBITRAGE_SEARCH_POLICY.allowedProtocols = [];
  await expect(runArbitrageBot()).rejects.toThrow('ARBITRAGE_SEARCH_POLICY.allowedProtocols');
  expect(initialize).not.toHaveBeenCalled();
});

test('V2-only market sync refreshes V2 and preserves stored V3 and Carbon markets', async () => {
  const { catalog } = prepareRuntime();
  const previousRpc = NETWORK.rpcUrl;
  const previousFlashQuery = CONTRACTS.flashQuery;
  // Discovery is stubbed, so no RPC calls or database writes occur.
  Object.assign(NETWORK, { rpcUrl: 'http://127.0.0.1:1' });
  Object.assign(CONTRACTS, { flashQuery: v2Address });
  const pools = [catalog.v2Pools[0], {
    ...catalog.v2Pools[0],
    pairAddress: '0x0000000000000000000000000000000000000006' as const,
  }];
  const v2Discover = spyOn(protocolPlugin('v2'), 'discover').mockImplementation(async context => {
    context.catalog.v2Pools = pools;
  });
  const v3Discover = spyOn(protocolPlugin('v3'), 'discover').mockResolvedValue();
  const carbonDiscover = spyOn(protocolPlugin('carbon'), 'discover').mockResolvedValue();
  const save = spyOn(marketDb, 'replaceMarketSnapshot').mockImplementation(() => {});
  try {
    await syncMarkets();
    expect(v2Discover).toHaveBeenCalledTimes(1);
    expect(v3Discover).not.toHaveBeenCalled();
    expect(carbonDiscover).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith({
      v2Pools: pools,
      v3Pools: catalog.v3Pools,
      carbonPairs: catalog.carbonPairs,
    });
  } finally {
    Object.assign(NETWORK, { rpcUrl: previousRpc });
    Object.assign(CONTRACTS, { flashQuery: previousFlashQuery });
  }
});

test('an explicit V3-only sync does not discover or replace V2 and Carbon', async () => {
  const { catalog } = prepareRuntime();
  const previousRpc = NETWORK.rpcUrl;
  const previousFlashQuery = CONTRACTS.flashQuery;
  Object.assign(NETWORK, { rpcUrl: 'http://127.0.0.1:1' });
  Object.assign(CONTRACTS, { flashQuery: v2Address });
  const discoveredV3 = [{ ...catalog.v3Pools[0], address: '0x0000000000000000000000000000000000000007' as const }];
  const v2Discover = spyOn(protocolPlugin('v2'), 'discover').mockResolvedValue();
  const v3Discover = spyOn(protocolPlugin('v3'), 'discover').mockImplementation(async context => {
    expect(context.catalog.v2Pools).toEqual(catalog.v2Pools);
    expect(context.catalog.carbonPairs).toEqual(catalog.carbonPairs);
    context.catalog.v3Pools = discoveredV3;
  });
  const carbonDiscover = spyOn(protocolPlugin('carbon'), 'discover').mockResolvedValue();
  const save = spyOn(marketDb, 'replaceMarketSnapshot').mockImplementation(() => {});
  try {
    await syncMarkets({ protocols: ['v3'] });
    expect(v2Discover).not.toHaveBeenCalled();
    expect(v3Discover).toHaveBeenCalledTimes(1);
    expect(carbonDiscover).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith({
      v2Pools: catalog.v2Pools,
      v3Pools: discoveredV3,
      carbonPairs: catalog.carbonPairs,
    });
  } finally {
    Object.assign(NETWORK, { rpcUrl: previousRpc });
    Object.assign(CONTRACTS, { flashQuery: previousFlashQuery });
  }
});

test('Carbon-only sync receives the stored V2 and V3 token universe', async () => {
  const { catalog } = prepareRuntime();
  const previousRpc = NETWORK.rpcUrl;
  const previousFlashQuery = CONTRACTS.flashQuery;
  Object.assign(NETWORK, { rpcUrl: 'http://127.0.0.1:1' });
  Object.assign(CONTRACTS, { flashQuery: v2Address });
  const carbonDiscover = spyOn(protocolPlugin('carbon'), 'discover').mockImplementation(async context => {
    expect(context.catalog.v2Pools).toEqual(catalog.v2Pools);
    expect(context.catalog.v3Pools).toEqual(catalog.v3Pools);
    context.catalog.carbonPairs = [];
  });
  const save = spyOn(marketDb, 'replaceMarketSnapshot').mockImplementation(() => {});
  try {
    await syncMarkets({ protocols: ['carbon'] });
    expect(carbonDiscover).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      v2Pools: catalog.v2Pools,
      v3Pools: catalog.v3Pools,
      carbonPairs: [],
    });
  } finally {
    Object.assign(NETWORK, { rpcUrl: previousRpc });
    Object.assign(CONTRACTS, { flashQuery: previousFlashQuery });
  }
});

test('sync protocol arguments support repeated, comma-separated, and all selections', () => {
  expect(parseSyncProtocols([])).toBeUndefined();
  expect(parseSyncProtocols(['--protocol', 'v3'])).toEqual(['v3']);
  expect(parseSyncProtocols(['--protocol', 'v2,carbon', '--protocol', 'v3'])).toEqual(['v2', 'carbon', 'v3']);
  expect(parseSyncProtocols(['--all'])).toEqual(['v2', 'v3', 'carbon']);
  expect(() => parseSyncProtocols(['--protocol', 'wrong'])).toThrow('Unknown protocol');
  expect(() => parseSyncProtocols(['--all', '--protocol', 'v3'])).toThrow('either --all or --protocol');
  expect(() => parseSyncProtocols(['--wat'])).toThrow('Unknown sync option');
});
