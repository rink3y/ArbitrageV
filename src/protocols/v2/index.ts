import { discoverV2PoolMetadata, refreshV2PoolMetadata, type V2Client } from './metadata';
import { getKnownPairsInfo, V2EventAdapter } from './runtime';
import { type ProtocolPlugin } from '../protocol-plugin';
import { v2FlashLoanFee } from './execution';
import { V2Store } from './store';
import { FactoryDiscoveryAdapter } from '../../runtime/factory-discovery-adapter';
import { RUNTIME } from '../../constants';
import { V2_FACTORIES } from './config';
import { profileV2Transfers } from './transfer-probes';
import { logger } from '../../reporting/logger';

export const v2Plugin: ProtocolPlugin = {
  id: 'v2',
  contractId: 0,
  flashLoanFee: v2FlashLoanFee,
  flashRepayFee: BigInt,
  count: catalog => catalog.v2Pools.length,
  async discover({ client, catalog }) {
    const store = new V2Store();
    try { catalog.v2Pools = await discoverV2PoolMetadata(client, store); }
    finally { store.close(); }
  },
  async hydrate({ client, catalog, graph }) {
    const pairs = await profileV2Transfers(client, await getKnownPairsInfo(client, catalog.v2Pools));
    for (const pair of pairs) graph.addPair(pair);
  },
  events: context => {
    const runtime = new V2EventAdapter(context.client, context.graph, context.catalog.v2Pools, context.scan);
    if (!context.liveMarkets) return runtime;
    const liveMarkets = context.liveMarkets;
    const factories = V2_FACTORIES.map(factory => factory.address);
    liveMarkets.registerV2(
      () => {
        const store = new V2Store();
        try { return store.pools(factories); }
        finally { store.close(); }
      },
      pools => runtime.replacePools(pools)
    );
    // Reconcile once on startup in case a previous run saved discovery but not its trading list.
    let needsReconcile = true;
    const discovery = new FactoryDiscoveryAdapter(
      'v2-factories',
      factories,
      (client, addresses, onLogs, onError) => client.watchEvent({ address: [...addresses], onLogs, onError }),
      async () => {
        try {
          const store = new V2Store();
          let changes;
          try { changes = await refreshV2PoolMetadata(context.client as unknown as V2Client, store); }
          finally { store.close(); }
          if (changes.poolsSaved > 0 || changes.factoriesReset > 0) {
            needsReconcile = true;
            logger.info('V2 discovery updated', changes);
          }
          if (needsReconcile) {
            await liveMarkets.reconcile();
            needsReconcile = false;
          }
        } catch (error) {
          // Discovery can commit batches before a later read or publication fails.
          needsReconcile = true;
          throw error;
        }
      },
      RUNTIME.marketDiscoveryIntervalMs
    );
    return [runtime, discovery];
  },
};
