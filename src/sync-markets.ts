import { createPublicClient, http } from 'viem';
import { sei } from 'viem/chains';
import { CONTRACTS, NETWORK, RUNTIME } from './constants';
import { filterDiscoveredMarkets } from './market-filter';
import { replaceMarketSnapshot } from './market-db';
import { enabledProtocolPlugins } from './protocols/registry';

export async function syncMarkets(): Promise<void> {
  const plugins = enabledProtocolPlugins();
  if (!NETWORK.rpcUrl) throw new Error('RPC_URL is required');
  if (!CONTRACTS.flashQuery) throw new Error('UNISWAP_FLASH_QUERY_CONTRACT_ADDRESS is required');

  const client = createPublicClient({
    chain: { ...sei, id: NETWORK.chainId },
    transport: http(NETWORK.rpcUrl),
  });

  const catalog = { v2Pools: [], v3Pools: [], carbonPairs: [] };
  for (const plugin of plugins) await plugin.discover({ client, catalog });

  const filtered = filterDiscoveredMarkets(catalog.v2Pools, catalog.v3Pools, catalog.carbonPairs);
  if (RUNTIME.debug) {
    console.log('Shared market filter:', {
      v2: `${catalog.v2Pools.length} -> ${filtered.v2Pools.length}`,
      v3: `${catalog.v3Pools.length} -> ${filtered.v3Pools.length}`,
      carbon: `${catalog.carbonPairs.length} -> ${filtered.carbonPairs.length}`,
    });
  }
  replaceMarketSnapshot({
    v2Pools: filtered.v2Pools,
    v3Pools: filtered.v3Pools,
    carbonPairs: filtered.carbonPairs,
  });

  console.log(`Stored ${filtered.v2Pools.length} V2 pools, ${filtered.v3Pools.length} V3 pools, and ${filtered.carbonPairs.length} Carbon pairs`);
}

if (import.meta.main) {
  syncMarkets().catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
}
