import { type Address } from 'viem';
import { ARBITRAGE_SEARCH_POLICY, EXECUTION_POLICY, RUNTIME, TOKENS } from '../constants';
import { OpportunityManager } from '../execute';
import { type ExecutableOpportunity } from '../execution/execution-planner';
import { type NetworkConfig } from '../network';
import { basisPoints, formatBasisPoints, formatTokenAmountWithSymbol } from '../values';
import { type MarketProtocol } from '../market-graph/types';
import { type OpportunityEngine } from './opportunity-engine';
import { WorkerSearch } from './worker-search';
import { backgroundLogs } from '../runtime/background-queue';
import { latency } from '../runtime/latency';
import {
  type ArbitrageSearchResult,
  type FindOpportunitiesRequest,
} from './opportunity-types';

export type OpportunityWorkflowRequest = {
  changedPairs?: readonly string[];
  releasedPairs?: readonly Address[];
  observedAt?: number;
};

export async function createOpportunityScanner(
  engine: OpportunityEngine,
  networkConfig: NetworkConfig
): Promise<{
  scan: (request?: OpportunityWorkflowRequest) => Promise<ArbitrageSearchResult>;
  warm: () => Promise<void>;
  stop: () => void;
}> {
  const manager = EXECUTION_POLICY.executeTrades ? new OpportunityManager(networkConfig) : null;
  try {
    await manager?.start();
  } catch (error) {
    manager?.stop();
    throw error;
  }
  const search = new WorkerSearch(engine.graph, engine.policy);
  let stopped = false;
  return {
    warm: async () => { await search.search({ startTokens: [] }); },
    scan: request => stopped ? Promise.resolve([]) : scanAndExecuteOpportunities(engine, search, manager, request),
    stop: () => { stopped = true; search.stop(); manager?.stop(); },
  };
}

async function scanAndExecuteOpportunities(
  engine: OpportunityEngine,
  search: WorkerSearch,
  manager: OpportunityManager | null,
  request: OpportunityWorkflowRequest = {}
): Promise<ArbitrageSearchResult> {
  if (manager && request.releasedPairs) manager.releasePairs(request.releasedPairs);

  const started = performance.now();
  const results = await search.search(createSearchRequest(request));
  const opportunities = results.filter(opportunity =>
    opportunity.marketVersions && engine.graph.matchesVersions(opportunity.marketVersions) &&
    Date.now() - opportunity.observedAt! <= RUNTIME.candidateMaxAgeMs);
  latency.observe('scan.roundTrip', performance.now() - started);
  latency.increment('search.stale', results.length - opportunities.length);

  if (manager && opportunities.length > 0) {
    const executableOpportunities: ExecutableOpportunity[] = opportunities
      .filter(opportunity =>
        opportunity.flashPoolAddress !== undefined &&
        opportunity.protocols.length === opportunity.pairs.length &&
        opportunity.routeData.length === opportunity.pairs.length
      );

    manager.processOpportunities(engine.graph, executableOpportunities).catch(error => {
      backgroundLogs.enqueue('execution-error', () => console.error('Error processing opportunities:', error));
    });
  }

  backgroundLogs.enqueue('opportunities', () => logOpportunities(opportunities));

  return opportunities;
}

function createSearchRequest(request: OpportunityWorkflowRequest): FindOpportunitiesRequest {
  const startTokens = TOKENS
    .slice(0, Math.min(ARBITRAGE_SEARCH_POLICY.topTokens, TOKENS.length))
    .map(addr => addr.address);

  return {
    startTokens,
    changedPairs: request.changedPairs,
    observedAt: request.observedAt ?? Date.now(),
  };
}

function logOpportunities(opportunities: ArbitrageSearchResult): void {
  if (opportunities.length === 0) {
    if (RUNTIME.debug) console.log('No profitable arbitrage opportunities found');
    return;
  }

  console.log(`\nFound ${opportunities.length} potential arbitrage opportunities:`);

  opportunities.forEach((opportunity, index) => {
    if (!RUNTIME.debug) return;

    const { path, profit, pairs, fees, optimalInput } = opportunity;
    const routeKind = routeKindFromProtocols(opportunity.protocols);
    const profitBps = basisPoints(profit, optimalInput);
    const startToken = path[0];
    const startTokenInfo = TOKENS.find(addr => addr.address === startToken);
    if (!startTokenInfo) throw new Error(`Token info not found for ${startToken}`);

    const lastToken = path[path.length - 1];
    const lastTokenInfo = TOKENS.find(addr => addr.address === lastToken);
    if (!lastTokenInfo) throw new Error(`Token info not found for ${lastToken}`);

    console.log(`\nOpportunity #${index + 1}:`);
    console.log(`Path: ${path.join(' -> ')}`);
    console.log(`Expected profit: ${formatTokenAmountWithSymbol(profit, lastTokenInfo)}`);
    console.log(`Route type: ${routeKind}`);
    console.log(`Optimal input amount: ${optimalInput.toString()} wei || ${formatTokenAmountWithSymbol(optimalInput, startTokenInfo)}`);
    console.log(`Profit percentage: ${formatBasisPoints(profitBps)}%`);
    console.log(`Pairs used: ${pairs.join(', ')}`);
    console.log(`Fees: ${fees.map(fee => fee.toString()).join(', ')}`);
  });
}

function routeKindFromProtocols(protocols: MarketProtocol[]): MarketProtocol | 'mixed' {
  if (protocols.length === 0) return 'mixed';
  return protocols.every(protocol => protocol === protocols[0]) ? protocols[0] : 'mixed';
}

