import { type Address } from 'viem';
import { ARBITRAGE_SEARCH_POLICY, EXECUTION_POLICY, RUNTIME, TOKENS } from '../constants';
import { OpportunityManager } from '../execute';
import { type ExecutableOpportunity } from '../execution/execution-planner';
import { type NetworkConfig } from '../network';
import { basisPoints, formatBasisPoints, formatTokenAmountWithSymbol } from '../values';
import { type MarketProtocol } from '../market-graph/types';
import { type OpportunityEngine } from './opportunity-engine';
import {
  type ArbitrageSearchResult,
  type FindOpportunitiesRequest,
} from './opportunity-types';

export type OpportunityWorkflowRequest = {
  changedPairs?: readonly string[];
  releasedPairs?: readonly Address[];
};

export function createOpportunityScanner(
  engine: OpportunityEngine,
  networkConfig: NetworkConfig
): (request?: OpportunityWorkflowRequest) => Promise<ArbitrageSearchResult> {
  const manager = EXECUTION_POLICY.executeTrades ? new OpportunityManager(networkConfig) : null;
  if (manager) void manager.warmNonce();
  return request => scanAndExecuteOpportunities(engine, manager, request);
}

async function scanAndExecuteOpportunities(
  engine: OpportunityEngine,
  manager: OpportunityManager | null,
  request: OpportunityWorkflowRequest = {}
): Promise<ArbitrageSearchResult> {
  if (manager && request.releasedPairs) manager.releasePairs(request.releasedPairs);

  const opportunities = engine.findOpportunities(createSearchRequest(request));
  logOpportunities(opportunities);

  if (manager && opportunities.length > 0) {
    const executableOpportunities: ExecutableOpportunity[] = opportunities
      .filter(opportunity =>
        opportunity.protocols.length === opportunity.pairs.length &&
        opportunity.routeData.length === opportunity.pairs.length
      );

    if (executableOpportunities.length === 0) return opportunities;

    manager.processOpportunities(engine, executableOpportunities).catch(error => {
      if (RUNTIME.debug) {
        console.error('Error processing opportunities:', error);
      }
    });
  }

  return opportunities;
}

function createSearchRequest(request: OpportunityWorkflowRequest): FindOpportunitiesRequest {
  const startTokens = TOKENS
    .slice(0, Math.min(ARBITRAGE_SEARCH_POLICY.topTokens, TOKENS.length))
    .map(addr => addr.address);

  if (RUNTIME.debug) {
    console.log(`Searching for arbitrage opportunities using ${startTokens.length} tokens simultaneously`);
    startTokens.forEach((token, i) => {
      console.log(`Token ${i + 1}: ${TOKENS[i].name} (${token})`);
    });
  }

  return {
    startTokens,
    changedPairs: request.changedPairs,
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

