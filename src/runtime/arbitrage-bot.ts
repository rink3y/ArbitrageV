import { logger, reportingStatus } from '../reporting/logger';
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
import { LiveMarketRegistry } from './live-market-registry';

type ScanUpdate = { key: string; releasedPairs: readonly Address[]; observedAt: number };

export async function runArbitrageBot(registerStop: (stop: () => Promise<void>) => void = () => {}): Promise<void> {
  const runtimePlugins = enabledProtocolPlugins();
  logger.info('Initializing network...');
  const network = await initializeNetwork();

  logger.info('Loading market metadata...');
  const catalog = loadMarketSnapshot();
  if (runtimePlugins.every(plugin => plugin.count(catalog) === 0)) {
    throw new Error('No markets for enabled protocols. Run `bun run sync:markets` first.');
  }

  logger.info(`Loaded ${runtimePlugins.map(plugin => `${plugin.count(catalog)} ${plugin.id}`).join(', ')} markets from SQLite`);

  logger.info('Building arbitrage graph...');
  const engine = new OpportunityEngine(ARBITRAGE_SEARCH_POLICY);
  const { scan: scanOpportunities, warm: warmSearch, stop: stopExecution } = await createOpportunityScanner(engine, network);
  let monitor: EventMonitor | undefined;
  let live = false;
  const metricsTimer = logger.enabled ? setInterval(() => {
    if (logger.enabled) {
      logger.metrics(latency.raw());
      logger.info('Reporting health', reportingStatus());
    }
  }, RUNTIME.metricsIntervalMs) : undefined;
  metricsTimer?.unref();
  let clearScans = () => {};
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (stopping) return stopping;
    live = false;
    stopExecution();
    clearScans();
    clearInterval(metricsTimer);
    stopping = monitor?.stop() ?? Promise.resolve();
    return stopping;
  };
  registerStop(stop);
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
        }); } catch (error) { logger.alert('search.failed', 'error', 'Opportunity scan failed', error); }
      },
      update => update.key.toLowerCase()
    );
    clearScans = () => scanScheduler.clear();
    const scheduleScan = (changedPairs: readonly string[], releasedPairs: readonly Address[] = []) =>
      live ? scanScheduler.submit(changedPairs.map(key => ({ key, releasedPairs, observedAt: marketReceipt(key) ?? Date.now() }))) : Promise.resolve();
    const liveMarkets = new LiveMarketRegistry(catalog);
    const eventAdapters = runtimePlugins
      .flatMap(plugin => {
        const adapters = plugin.events({ client: network.client, catalog, graph: engine.graph, scan: scheduleScan, liveMarkets });
        return adapters === null ? [] : Array.isArray(adapters) ? adapters : [adapters];
      });
    monitor = new EventMonitor(network, eventAdapters, ready => { live = ready; engine.graph.setFeedReady(ready); });

    logger.info('Starting market event feed in buffering mode...');
    await monitor.startBuffering();

    logger.info(`Fetching live state for ${runtimePlugins.map(plugin => plugin.id).join(', ')}...`);
    const hydrationStartedAtBlock = await network.client.getBlockNumber();
    await Promise.all(runtimePlugins.map(plugin => plugin.hydrate({
      client: network.client,
      catalog,
      graph: engine.graph,
      blockNumber: hydrationStartedAtBlock,
    })));
    const hydrationCompletedAtBlock = await network.client.getBlockNumber();
    logger.info(`Initial live state fetched across blocks ${hydrationStartedAtBlock}-${hydrationCompletedAtBlock}`);

    if (logger.debugEnabled) logger.debug(`Loaded live state for ${runtimePlugins.map(plugin => plugin.id).join(', ')}`);
    logger.info('Reconciling events received during startup...');
    // Transfer the initial graph while the feed is still buffering. Live scans
    // then send only changed pools/ticks, never the entire catalog.
    await warmSearch();
    await monitor.activate(hydrationStartedAtBlock);
    logger.info('Searching for initial arbitrage opportunities...');
    await scheduleScan(['$all']);

  } catch (error) {
    // Do not hide a fatal startup error behind a stuck unsubscribe. The entry
    // point owns the bounded wait and invokes this same idempotent stop.
    void stop().catch(cleanupError => logger.error('Market cleanup failed', cleanupError));
    throw error;
  }
}
