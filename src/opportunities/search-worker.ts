import { OpportunityEngine } from './opportunity-engine';
import { type GraphChanges } from '../market-graph/changes';
import { type ArbitrageSearchPolicy } from '../market-graph/types';
import { type FindOpportunitiesRequest } from './opportunity-types';
import { RUNTIME, type TokenConfig } from '../constants';
import { latency } from '../runtime/latency';
import { type LogLevel } from '../reporting/records';

declare var self: Worker;
let engine: OpportunityEngine | undefined;
self.onmessage = (event: MessageEvent<{ policy: ArbitrageSearchPolicy; tokens: readonly TokenConfig[]; changes: GraphChanges; request: FindOpportunitiesRequest; logLevel: LogLevel }>) => {
  try {
    RUNTIME.logLevel = event.data.logLevel;
    engine ??= new OpportunityEngine(event.data.policy, [], event.data.tokens);
    const applyStarted = latency.now();
    engine.graph.applyChanges(event.data.changes);
    const searchStarted = latency.now();
    const opportunities = engine.findOpportunities(event.data.request);
    self.postMessage({ opportunities, stats: engine.lastSearchStats, splitStats: engine.lastSplitStats,
      diagnostics: engine.diagnostics, applyMs: searchStarted - applyStarted, searchMs: latency.now() - searchStarted });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
