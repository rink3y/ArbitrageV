import { OpportunityEngine } from './opportunity-engine';
import { type GraphChanges } from '../market-graph/changes';
import { type ArbitrageSearchPolicy } from '../market-graph/types';
import { type FindOpportunitiesRequest } from './opportunity-types';

declare var self: Worker;
let engine: OpportunityEngine | undefined;
self.onmessage = (event: MessageEvent<{ policy: ArbitrageSearchPolicy; changes: GraphChanges; request: FindOpportunitiesRequest }>) => {
  try {
    engine ??= new OpportunityEngine(event.data.policy);
    const applyStarted = performance.now();
    engine.graph.applyChanges(event.data.changes);
    const searchStarted = performance.now();
    const opportunities = engine.findOpportunities(event.data.request);
    self.postMessage({ opportunities, stats: engine.lastSearchStats,
      applyMs: searchStarted - applyStarted, searchMs: performance.now() - searchStarted });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
