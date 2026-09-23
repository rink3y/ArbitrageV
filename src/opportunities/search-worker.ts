import { OpportunityEngine } from './opportunity-engine';
import { type GraphChanges } from '../market-graph/changes';
import { type ArbitrageSearchPolicy } from '../market-graph/types';
import { type FindOpportunitiesRequest } from './opportunity-types';
import { type TokenConfig } from '../constants';

declare var self: Worker;
let engine: OpportunityEngine | undefined;
self.onmessage = (event: MessageEvent<{ policy: ArbitrageSearchPolicy; tokens: readonly TokenConfig[]; changes: GraphChanges; request: FindOpportunitiesRequest }>) => {
  try {
    engine ??= new OpportunityEngine(event.data.policy, [], event.data.tokens);
    const applyStarted = performance.now();
    engine.graph.applyChanges(event.data.changes);
    const searchStarted = performance.now();
    const opportunities = engine.findOpportunities(event.data.request);
    self.postMessage({ opportunities, stats: engine.lastSearchStats, splitStats: engine.lastSplitStats,
      applyMs: searchStarted - applyStarted, searchMs: performance.now() - searchStarted });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
