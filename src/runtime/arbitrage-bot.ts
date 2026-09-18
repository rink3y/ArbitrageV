import { type Address } from 'viem';
import { ARBITRAGE_SEARCH_POLICY, RUNTIME } from '../constants';
import { EventMonitor } from '../runtime/event-monitor';
import { loadMarketSnapshot } from '../market-db';
import { initializeNetwork } from '../network';
import { OpportunityEngine } from '../opportunities/opportunity-engine';
import { createOpportunityScanner } from '../opportunities/opportunity-workflow';
import { enabledProtocolPlugins } from '../protocols/registry';
import { LatestUpdateScheduler } from './event-scheduler';

type ScanUpdate = { key: string; releasedPairs: readonly Address[] };

export async function runArbitrageBot(): Promise<void> {
  const runtimePlugins = enabledProtocolPlugins();
  console.log('Initializing network...');
  const network = await initializeNetwork();

  console.log('Loading market metadata...');
  const catalog = loadMarketSnapshot();
  if (runtimePlugins.every(plugin => plugin.count(catalog) === 0)) {
    throw new Error('No markets for enabled protocols. Run `bun run sync:markets` first.');
  }

  console.log(`Loaded ${runtimePlugins.map(plugin => `${plugin.count(catalog)} ${plugin.id}`).join(', ')} markets from SQLite`);

  console.log('Building arbitrage graph...');
  const engine = new OpportunityEngine(ARBITRAGE_SEARCH_POLICY);
  const { scan: scanOpportunities, stop: stopExecution } = await createOpportunityScanner(engine, network);
  let monitor: EventMonitor | undefined;
  try {
    const scanScheduler = new LatestUpdateScheduler<ScanUpdate>(
      async updates => {
        const releasedPairs = new Map<string, Address>();
        for (const update of updates) {
          for (const pair of update.releasedPairs) releasedPairs.set(pair.toLowerCase(), pair);
        }
        await scanOpportunities({
          changedPairs: updates.map(update => update.key),
          releasedPairs: [...releasedPairs.values()],
        });
      },
      update => update.key.toLowerCase()
    );
    const scheduleScan = (changedPairs: readonly string[], releasedPairs: readonly Address[] = []) =>
      scanScheduler.submit(changedPairs.map(key => ({ key, releasedPairs })));
    const eventAdapters = runtimePlugins
      .map(plugin => plugin.events({ client: network.client, catalog, graph: engine.graph, scan: scheduleScan }))
      .filter(adapter => adapter !== null);
    monitor = new EventMonitor(network, eventAdapters);

    console.log('Starting market event feed in buffering mode...');
    await monitor.startBuffering();

    console.log(`Fetching live state for ${runtimePlugins.map(plugin => plugin.id).join(', ')}...`);
    const hydrationStartedAtBlock = await network.client.getBlockNumber();
    await Promise.all(runtimePlugins.map(plugin => plugin.hydrate({
      client: network.client,
      catalog,
      graph: engine.graph,
      blockNumber: hydrationStartedAtBlock,
    })));
    const hydrationCompletedAtBlock = await network.client.getBlockNumber();
    console.log(`Initial live state fetched across blocks ${hydrationStartedAtBlock}-${hydrationCompletedAtBlock}`);

    if (RUNTIME.debug) console.log(`Loaded live state for ${runtimePlugins.map(plugin => plugin.id).join(', ')}`);
    console.log('Reconciling events received during startup...');
    await monitor.activate(hydrationStartedAtBlock);
    console.log('Searching for initial arbitrage opportunities...');
    await scanOpportunities();

    process.on('SIGINT', async () => {
      console.log('\nStopping event monitor...');
      stopExecution();
      await monitor?.stop();
      process.exit();
    });
  } catch (error) {
    stopExecution();
    await monitor?.stop();
    throw error;
  }
}
