import { type Address } from 'viem';
import { ARBITRAGE_SEARCH_POLICY, RUNTIME } from '../constants';
import { EventMonitor } from '../runtime/event-monitor';
import { loadMarketSnapshot } from '../market-db';
import { initializeNetwork } from '../network';
import { OpportunityEngine } from '../opportunities/opportunity-engine';
import { createOpportunityScanner } from '../opportunities/opportunity-workflow';
import { enabledProtocolPlugins } from '../protocols/registry';
import { LatestUpdateScheduler } from './event-scheduler';
import { latency, marketReceipt } from './latency';
import { backgroundLogs } from './background-queue';
import { LiveMarketRegistry } from './live-market-registry';

type ScanUpdate = { key: string; releasedPairs: readonly Address[]; observedAt: number };

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
  const { scan: scanOpportunities, warm: warmSearch, stop: stopExecution } = await createOpportunityScanner(engine, network);
  let monitor: EventMonitor | undefined;
  let live = false;
  const metricsTimer = setInterval(() => backgroundLogs.enqueue('metrics', () => console.log('Latency:', latency.snapshot())), RUNTIME.metricsIntervalMs);
  metricsTimer.unref();
  try {
    const scanScheduler = new LatestUpdateScheduler<ScanUpdate>(
      async updates => {
        const releasedPairs = new Map<string, Address>();
        for (const update of updates) {
          for (const pair of update.releasedPairs) releasedPairs.set(pair.toLowerCase(), pair);
        }
        try { await scanOpportunities({
          changedPairs: updates.some(update => update.key === '$all') ? undefined : updates.map(update => update.key),
          releasedPairs: [...releasedPairs.values()],
          observedAt: updates.reduce((oldest, update) => Math.min(oldest, update.observedAt), Date.now()),
        }); } catch (error) { console.error('Opportunity scan failed:', error); }
      },
      update => update.key.toLowerCase()
    );
    const scheduleScan = (changedPairs: readonly string[], releasedPairs: readonly Address[] = []) =>
      live ? scanScheduler.submit(changedPairs.map(key => ({ key, releasedPairs, observedAt: marketReceipt(key) ?? Date.now() }))) : Promise.resolve();
    const liveMarkets = new LiveMarketRegistry(catalog);
    const eventAdapters = runtimePlugins
      .flatMap(plugin => {
        const adapters = plugin.events({ client: network.client, catalog, graph: engine.graph, scan: scheduleScan, liveMarkets });
        return adapters === null ? [] : Array.isArray(adapters) ? adapters : [adapters];
      });
    monitor = new EventMonitor(network, eventAdapters, ready => { live = ready; engine.graph.setFeedReady(ready); });

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
    // Transfer the initial graph while the feed is still buffering. Live scans
    // then send only changed pools/ticks, never the entire catalog.
    await warmSearch();
    await monitor.activate(hydrationStartedAtBlock);
    console.log('Searching for initial arbitrage opportunities...');
    await scheduleScan(['$all']);

    process.on('SIGINT', async () => {
      console.log('\nStopping event monitor...');
      stopExecution();
      scanScheduler.clear();
      clearInterval(metricsTimer);
      await monitor?.stop();
      process.exit();
    });
  } catch (error) {
    stopExecution();
    clearInterval(metricsTimer);
    await monitor?.stop();
    throw error;
  }
}
