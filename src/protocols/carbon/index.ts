import { discoverCarbonPairs } from './metadata';
import { CarbonEventAdapter, CarbonStrategyStore } from './runtime';
import { marketTokens } from '../../market-filter';
import { type ProtocolPlugin } from '../protocol-plugin';

export function createCarbonPlugin(): ProtocolPlugin {
  let store: CarbonStrategyStore | undefined;
  return {
    id: 'carbon',
    contractId: 2,
    count: catalog => catalog.carbonPairs.length,
    async discover({ client, catalog }) {
      catalog.carbonPairs = await discoverCarbonPairs(client, {
        allowedTokens: marketTokens(catalog.v2Pools, catalog.v3Pools),
      });
    },
    async hydrate() {
      await store?.loadAll();
    },
    events: context => {
      if (context.catalog.carbonPairs.length === 0) return null;
      store ??= new CarbonStrategyStore(
        context.client,
        context.catalog.carbonPairs,
        async (update, changedPoolKeys, changedController) => {
          if (update.kind === 'snapshot') context.graph.setCarbonStrategies(update.strategies);
          else context.graph.updateCarbonStrategies(update);
          if (changedPoolKeys.length > 0) {
            await context.scan(changedPoolKeys, changedController ? [changedController] : []);
          }
        }
      );
      return new CarbonEventAdapter(store);
    },
  };
}
