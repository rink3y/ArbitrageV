import { discoverV3Pools, V3_POOL_CREATED } from './metadata';
import { type ProtocolPlugin } from '../protocol-plugin';
import { v3FlashLoanFee } from './execution';
import { V3EventAdapter } from './runtime';
import { V3Store } from './store';
import { V3_FACTORIES } from './config';
import { FactoryDiscoveryAdapter } from '../../runtime/factory-discovery-adapter';
import { RUNTIME } from '../../constants';
import { type V3Client } from './query';

let runtime: V3EventAdapter | undefined;

export const v3Plugin: ProtocolPlugin = {
  id: 'v3',
  contractId: 1,
  flashLoanFee: v3FlashLoanFee,
  count: catalog => catalog.v3Pools.length,
  async discover({ client, catalog }) {
    const store = new V3Store();
    try { catalog.v3Pools = await discoverV3Pools(client, store); }
    finally { store.close(); }
  },
  async hydrate({ blockNumber }) {
    await runtime?.hydrate(blockNumber);
  },
  events: context => {
    const store = new V3Store();
    const discovered = store.pools(V3_FACTORIES.filter(factory => factory.enabled).map(factory => factory.address));
    const selected = new Set(context.catalog.v3Pools.map(pool => pool.address.toLowerCase()));
    const pools = discovered.filter(pool => selected.has(pool.address.toLowerCase()));
    if (selected.size > 0 && discovered.length === 0 && V3_FACTORIES.some(factory => factory.enabled)) {
      store.close();
      throw new Error('V3 factory metadata is missing. Run bun run sync:markets first.');
    }
    const adapter = new V3EventAdapter(context.client, context.graph, pools, context.scan, store);
    runtime = adapter;
    if (!context.liveMarkets) return adapter;
    const liveMarkets = context.liveMarkets;
    const factories = V3_FACTORIES.filter(factory => factory.enabled);
    const addresses = factories.map(factory => factory.address);
    liveMarkets.registerV3(
      () => {
        const catalog = new V3Store();
        try { return catalog.pools(addresses); }
        finally { catalog.close(); }
      },
      pools => adapter.replacePools(pools)
    );
    const discovery = new FactoryDiscoveryAdapter(
      'v3-factories',
      addresses,
      (client, factoryAddresses, onLogs, onError) => client.watchContractEvent({
        address: [...factoryAddresses],
        abi: [V3_POOL_CREATED],
        strict: true,
        onLogs,
        onError,
      }),
      async () => {
        const catalog = new V3Store();
        try { await discoverV3Pools(context.client as unknown as V3Client, catalog); }
        finally { catalog.close(); }
        await liveMarkets.reconcile();
      },
      RUNTIME.marketDiscoveryIntervalMs
    );
    return [adapter, discovery];
  },
};
