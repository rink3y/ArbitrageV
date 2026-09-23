import { CONTRACTS, RUNTIME } from './constants';
import { filterDiscoveredMarkets } from './market-filter';
import { loadMarketSnapshot, replaceMarketSnapshot, type MarketSnapshot } from './market-db';
import { type MarketProtocol } from './market-graph/types';
import { assertRpcChain, createReadClient } from './network';
import { enabledProtocolPlugins, PROTOCOL_PLUGINS } from './protocols/registry';

export type SyncMarketsOptions = {
  protocols?: readonly MarketProtocol[];
};

export async function syncMarkets(options: SyncMarketsOptions = {}): Promise<void> {
  const plugins = enabledProtocolPlugins(options.protocols);
  const selected = new Set(plugins.map(plugin => plugin.id));
  const client = createReadClient();
  if (!CONTRACTS.flashQuery) throw new Error('UNISWAP_FLASH_QUERY_CONTRACT_ADDRESS is required');
  await assertRpcChain(client);

  const existing = loadMarketSnapshot();
  const catalog: MarketSnapshot = {
    v2Pools: [...existing.v2Pools],
    v3Pools: [...existing.v3Pools],
    carbonPairs: [...existing.carbonPairs],
  };
  for (const plugin of plugins) await plugin.discover({ client, catalog });

  const filtered = filterDiscoveredMarkets(catalog.v2Pools, catalog.v3Pools, catalog.carbonPairs);
  if (RUNTIME.debug) {
    console.log('Shared market filter:', {
      v2: `${catalog.v2Pools.length} -> ${filtered.v2Pools.length}`,
      v3: `${catalog.v3Pools.length} -> ${filtered.v3Pools.length}`,
      carbon: `${catalog.carbonPairs.length} -> ${filtered.carbonPairs.length}`,
    });
  }
  const next = mergeSelectedMarkets(existing, filtered, selected);
  replaceMarketSnapshot(next);

  console.log(`Synchronized ${plugins.map(plugin => plugin.id).join(', ')}. Database now contains ${next.v2Pools.length} V2 pools, ${next.v3Pools.length} V3 pools, and ${next.carbonPairs.length} Carbon pairs`);
}

export function parseSyncProtocols(args: readonly string[]): MarketProtocol[] | undefined {
  if (args.length === 0) return undefined;
  const known = new Set(PROTOCOL_PLUGINS.map(plugin => plugin.id));
  const selected = new Set<MarketProtocol>();
  let all = false;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--all') {
      all = true;
      continue;
    }
    if (argument !== '--protocol') throw new Error(`Unknown sync option: ${argument}`);
    const value = args[++index];
    if (!value) throw new Error('--protocol requires v2, v3, or carbon');
    for (const id of value.split(',')) {
      if (!known.has(id as MarketProtocol)) throw new Error(`Unknown protocol: ${id}`);
      selected.add(id as MarketProtocol);
    }
  }

  if (all && selected.size > 0) throw new Error('Use either --all or --protocol, not both');
  return all ? PROTOCOL_PLUGINS.map(plugin => plugin.id) : [...selected];
}

function mergeSelectedMarkets(
  existing: MarketSnapshot,
  discovered: MarketSnapshot,
  selected: ReadonlySet<MarketProtocol>
): MarketSnapshot {
  return {
    v2Pools: selected.has('v2') ? discovered.v2Pools : existing.v2Pools,
    v3Pools: selected.has('v3') ? discovered.v3Pools : existing.v3Pools,
    carbonPairs: selected.has('carbon') ? discovered.carbonPairs : existing.carbonPairs,
  };
}

if (import.meta.main) {
  let protocols: MarketProtocol[] | undefined;
  try {
    protocols = parseSyncProtocols(process.argv.slice(2));
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
  syncMarkets({ protocols }).catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
}
