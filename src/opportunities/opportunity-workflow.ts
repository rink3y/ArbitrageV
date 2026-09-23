import { type Address } from 'viem';
import { EXECUTION_POLICY, RUNTIME, TOKENS } from '../constants';
import { OpportunityManager } from '../execute';
import { type ExecutableOpportunity } from '../execution/execution-planner';
import { type NetworkConfig } from '../network';
import { GasFees } from '../execution/gas-fees';
import { basisPoints, formatBasisPoints, formatTokenAmountWithSymbol } from '../values';
import { type MarketProtocol } from '../market-graph/types';
import { type OpportunityEngine } from './opportunity-engine';
import { WorkerSearch } from './worker-search';
import { splitCostsFromSnapshot } from './split-costs';
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
  const gasFees = new GasFees(type => networkConfig.client.estimateFeesPerGas({ type, chain: networkConfig.client.chain }));
  const manager = EXECUTION_POLICY.executeTrades ? new OpportunityManager(networkConfig, undefined, gasFees) : null;
  try {
    await gasFees.start();
    await manager?.start();
  } catch (error) {
    manager?.stop();
    gasFees.stop();
    throw error;
  }
  const search = new WorkerSearch(engine.graph, engine.policy, engine.tokens);
  let stopped = false;
  return {
    warm: async () => { await search.search({ startTokens: [] }); },
    scan: request => stopped ? Promise.resolve([]) : scanAndExecuteOpportunities(engine, search, manager, gasFees, request),
    stop: () => { stopped = true; search.stop(); manager?.stop(); gasFees.stop(); },
  };
}

async function scanAndExecuteOpportunities(
  engine: OpportunityEngine,
  search: WorkerSearch,
  manager: OpportunityManager | null,
  gasFees: GasFees,
  request: OpportunityWorkflowRequest = {}
): Promise<ArbitrageSearchResult> {
  if (manager && request.releasedPairs) manager.releasePairs(request.releasedPairs);

  const started = performance.now();
  const feeSnapshot = gasFees.current();
  if (!feeSnapshot) { latency.increment('fees.unavailable'); return []; }
  const searchRequest = createSearchRequest(engine, request);
  latency.observe('scan.inputAge', Math.max(0, Date.now() - searchRequest.observedAt!));
  const results = await search.search({
    ...searchRequest,
    splitCosts: splitCostsFromSnapshot(engine.tokens, feeSnapshot),
  });
  const checkedAt = Date.now();
  const opportunities: ArbitrageSearchResult = [];
  const expired: ArbitrageSearchResult = [];
  const invalidated: ArbitrageSearchResult = [];
  for (const opportunity of results) {
    if (!opportunity.marketVersions || !engine.graph.matchesVersions(opportunity.marketVersions)) {
      invalidated.push(opportunity);
    } else if (opportunity.observedAt === undefined || checkedAt - opportunity.observedAt > RUNTIME.candidateMaxAgeMs) {
      expired.push(opportunity);
    } else {
      opportunities.push(opportunity);
    }
  }
  latency.observe('scan.roundTrip', performance.now() - started);
  if (results[0]?.observedAt !== undefined) latency.observe('scan.resultAge', Math.max(0, checkedAt - results[0].observedAt));
  latency.increment('search.stale', expired.length + invalidated.length);
  latency.increment('search.expired', expired.length);
  latency.increment('search.invalidated', invalidated.length);

  if (manager && opportunities.length > 0) {
    const executableOpportunities: ExecutableOpportunity[] = opportunities
      .filter(opportunity =>
        opportunity.flashPoolAddress !== undefined &&
        opportunity.protocols.length === opportunity.pairs.length &&
        opportunity.routeData.length === opportunity.pairs.length
      );

    manager.processOpportunities(engine.graph, executableOpportunities, feeSnapshot).catch(error => {
      backgroundLogs.enqueue('execution-error', () => console.error('Error processing opportunities:', error));
    });
  }

  backgroundLogs.enqueue('opportunities', () => logOpportunities(results, opportunities, expired, invalidated, checkedAt));

  return opportunities;
}

function createSearchRequest(engine: OpportunityEngine, request: OpportunityWorkflowRequest): FindOpportunitiesRequest {
  const startTokens = engine.startTokens;

  return {
    startTokens,
    changedPairs: request.changedPairs,
    observedAt: request.observedAt ?? Date.now(),
  };
}

function logOpportunities(
  results: ArbitrageSearchResult,
  eligible: ArbitrageSearchResult,
  expired: ArbitrageSearchResult,
  invalidated: ArbitrageSearchResult,
  checkedAt: number
): void {
  if (results.length === 0) {
    if (RUNTIME.debug) console.log('No profitable arbitrage opportunities found');
    return;
  }

  console.log(`\nFound ${results.length} profitable quotes: ${eligible.length} eligible, ${expired.length} expired, ${invalidated.length} invalidated`);
  if (!RUNTIME.debug) return;
  const expiredSet = new Set(expired);
  const invalidatedSet = new Set(invalidated);

  results.forEach((opportunity, index) => {
    const { path, profit, pairs, fees, optimalInput } = opportunity;
    const routeKind = routeKindFromProtocols(opportunity.protocols);
    const profitBps = basisPoints(profit, optimalInput);
    const startToken = path[0];
    const startTokenInfo = TOKENS.find(addr => addr.address === startToken);
    if (!startTokenInfo) throw new Error(`Token info not found for ${startToken}`);

    const lastToken = path[path.length - 1];
    const lastTokenInfo = TOKENS.find(addr => addr.address === lastToken);
    if (!lastTokenInfo) throw new Error(`Token info not found for ${lastToken}`);

    const status = invalidatedSet.has(opportunity) ? 'market changed or feed unavailable; not executable'
      : expiredSet.has(opportunity) ? 'expired; not executable' : null;
    console.log(status ? `\nQuote #${index + 1} (${status}):` : `\nOpportunity #${index + 1}:`);
    console.log(`Path: ${path.join(' -> ')}`);
    console.log(`${status ? 'Quoted' : 'Expected'} profit: ${formatTokenAmountWithSymbol(profit, lastTokenInfo)}`);
    if (opportunity.netProfit !== undefined) console.log(`Conservative net after gas: ${formatTokenAmountWithSymbol(opportunity.netProfit, lastTokenInfo)}`);
    if (expiredSet.has(opportunity)) console.log(`Age at check: ${opportunity.observedAt === undefined ? 'unknown' : `${checkedAt - opportunity.observedAt} ms`} (limit ${RUNTIME.candidateMaxAgeMs} ms)`);
    console.log(`Route type: ${routeKind}`);
    if (opportunity.split) console.log(`Split ${opportunity.split.mode}: ${opportunity.split.stages.map(stage => stage.branches.length).join(' -> ')} branches; conservative net ${opportunity.netProfit}`);
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

