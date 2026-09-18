import { discoverV2PoolMetadata } from './metadata';
import { getKnownPairsInfo, V2EventAdapter } from './runtime';
import { type ProtocolPlugin } from '../protocol-plugin';
import { v2FlashLoanFee } from './execution';

export const v2Plugin: ProtocolPlugin = {
  id: 'v2',
  contractId: 0,
  flashLoanFee: v2FlashLoanFee,
  flashRepayFee: BigInt,
  count: catalog => catalog.v2Pools.length,
  async discover({ client, catalog }) {
    catalog.v2Pools = await discoverV2PoolMetadata(client);
  },
  async hydrate({ client, catalog, graph }) {
    const pairs = await getKnownPairsInfo(client, catalog.v2Pools);
    for (const pair of pairs) graph.addPair(pair);
  },
  events: context => new V2EventAdapter(context.client, context.graph, context.catalog.v2Pools, context.scan),
};
