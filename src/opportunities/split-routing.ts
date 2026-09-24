import { type Address, type Hex } from 'viem';
import { EXECUTION_POLICY, TOKENS, type TokenConfig } from '../constants';

import { type MarketGraph } from '../market-graph/market-graph';
import { type AnyMarketEdge, type MarketProtocol } from '../market-graph/types';
import { encodeCarbonRouteData } from '../protocols/carbon/execution';
import { encodeV2RouteData } from '../protocols/v2/execution';
import { flashLoanFee } from '../execution/execution-planner';
import { type FlashPoolCandidate } from '../market-graph/types';

// Search resolution, not user policy. The contract permits 3 stages with 2 branches each.
const SAMPLES = 8;
const REFINEMENTS = 3;

export type SplitCosts = {
  validUntil: number;
  gasPriceWei: bigint;
  // Smallest borrow-token units per native-token wei. Never infer this from minProfit.
  rates: Record<string, { numerator: bigint; denominator: bigint }>;
};
export type SplitCandidate = {
  path: Address[]; quote: SplitQuote; flashPool: FlashPoolCandidate;
  netProfit: bigint; gasCost: bigint; minSurplusAfterRepayment: bigint;
};

export function splitGasCost(costs: SplitCosts | undefined, token: Address, now = Date.now()): bigint | null {
  const rate = costs?.rates[token.toLowerCase()];
  if (!costs || !Number.isFinite(costs.validUntil) || costs.validUntil <= now || costs.gasPriceWei <= 0n ||
      !rate || rate.numerator <= 0n || rate.denominator <= 0n || EXECUTION_POLICY.gasLimit <= 0n) return null;
  return (EXECUTION_POLICY.gasLimit * costs.gasPriceWei * rate.numerator + rate.denominator - 1n) / rate.denominator;
}

export type SplitBranch = {
  pool: Address; protocol: MarketProtocol; fee: number; data: Hex;
  amountIn: bigint; minAmountOut: bigint;
};
export type SplitStage = { tokenIn: Address; tokenOut: Address; branches: SplitBranch[] };
export type SplitQuote = { amountIn: bigint; amountOut: bigint; stages: SplitStage[]; resources: string[] };
export type SplitAllocation = { edgeIndex: number; amountIn: bigint };

// A Carbon group and one of its component orders cannot both spend the same strategy.
export function liquidityResources(edge: AnyMarketEdge): string[] {
  const pool = edge.poolAddress.toLowerCase();
  if (edge.protocol !== 'carbon') return [pool];
  return (edge.carbonKind === 'single' ? [edge.strategyId] : edge.orders.map(order => order.strategyId))
    .map(id => `${pool}:${id}`);
}

export function quoteSplitStages(
  graph: MarketGraph, path: Address[], allocations: SplitAllocation[][], slippageBps: number,
  spendWork?: () => boolean,
): SplitQuote | null {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000 ||
      allocations.length < 2 || allocations.length > 3 || path.length !== allocations.length + 1 ||
      path[0].toLowerCase() !== path.at(-1)!.toLowerCase()) return null;
  const resources = new Set<string>();
  const stages: SplitStage[] = [];
  let amountIn = 0n;
  let available = 0n;
  for (let i = 0; i < allocations.length; i++) {
    if (allocations[i].length < 1 || allocations[i].length > 2 || path[i].toLowerCase() === path[i + 1].toLowerCase()) return null;
    const stage: SplitStage = { tokenIn: path[i], tokenOut: path[i + 1], branches: [] };
    let spent = 0n;
    let received = 0n;
    for (const allocation of allocations[i]) {
      if (allocation.amountIn <= 0n || (spendWork && !spendWork())) return null;
      const edge = graph.edgeAt(allocation.edgeIndex);
      if (!edge || edge.from.toLowerCase() !== stage.tokenIn.toLowerCase() || edge.to.toLowerCase() !== stage.tokenOut.toLowerCase() ||
          !graph.policy.allowedProtocols.includes(edge.protocol)) return null;
      const maxInput = (1n << BigInt(edge.protocol === 'carbon' ? 128 : edge.protocol === 'v3' ? 255 : 256)) - 1n;
      if (allocation.amountIn > maxInput) return null;
      for (const resource of liquidityResources(edge)) {
        if (resources.has(resource)) return null;
        resources.add(resource);
      }
      let quote;
      try { quote = graph.quoteEdgeAt(allocation.edgeIndex, allocation.amountIn, spendWork); }
      catch { return null; }
      if (!quote.complete) return null;
      const minAmountOut = quote.amountOut * BigInt(10_000 - slippageBps) / 10_000n;
      if (minAmountOut <= 0n) return null;
      let data: Hex = edge.protocol === 'v2' ? encodeV2RouteData(edge.variant, !!edge.transferFees) : '0x';
      if (edge.protocol === 'carbon') {
        const execution = graph.carbonExecution(allocation.edgeIndex, allocation.amountIn);
        if (!execution) return null;
        data = encodeCarbonRouteData(execution);
      }
      stage.branches.push({ pool: edge.poolAddress, protocol: edge.protocol, fee: edge.fee, data, amountIn: allocation.amountIn, minAmountOut });
      spent += allocation.amountIn;
      received += minAmountOut;
    }
    if (i === 0) amountIn = spent;
    else if (spent > available) return null;
    available = received;
    stages.push(stage);
  }
  if (!graph.policy.allowProtocolMixing && new Set(stages.flatMap(stage => stage.branches.map(branch => branch.protocol))).size > 1) return null;
  return { amountIn, amountOut: available, stages, resources: [...resources] };
}

/** Bounded heuristic over short token cycles. A budget stop is not proof of no arbitrage. */
export function searchSplitRoutes(
  graph: MarketGraph, paths: Address[][], tokens: readonly TokenConfig[] = TOKENS, costs?: SplitCosts,
  baselineNet: ReadonlyMap<string, bigint> = new Map(),
): { best: SplitCandidate | null; candidates: SplitCandidate[]; work: number; evaluated: number; exhausted: boolean } {
  const policy = graph.policy;
  const maxCandidates = policy.maxCandidatesToSize ?? 64;
  const maxWork = policy.maxSearchExpansions ?? 50_000;
  const maxTimeMs = policy.splitSearchMs ?? 10;
  const maxStages = Math.min(policy.maxRouteEdges, 3);
  const alternatives = Math.min(policy.beamWidth, 4);
  const { slippageBps } = EXECUTION_POLICY;
  let work = 0;
  let evaluated = 0;
  let exhausted = false;
  const winners = new Map<string, SplitCandidate>();
  const result = () => ({ best: winners.values().next().value ?? null, candidates: [...winners.values()], work, evaluated,
    exhausted: exhausted || evaluated >= maxCandidates });
  if (policy.splitRouting !== 'live' || paths.length === 0) return result();
  const tokenByAddress = new Map(tokens.slice(0, policy.topTokens).map(token => [token.address.toLowerCase(), token]));
  for (const value of [maxCandidates, maxWork, alternatives]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid split search budget');
  }
  if (!Number.isInteger(maxStages) || maxStages < 2 || alternatives < 1 ||
      !Number.isFinite(maxTimeMs) || maxTimeMs <= 0 ||
      policy.maxInputReserveFraction < 1n || slippageBps < 0 || slippageBps >= 10000 ||
      !Number.isInteger(slippageBps)) throw new Error('Invalid split limits');
  const end = performance.now() + maxTimeMs;
  const spend = () => {
    if (work >= maxWork || performance.now() >= end) { exhausted = true; return false; }
    work++;
    return true;
  };
  const seen = new Set<string>();
  for (const path of paths) {
    if (!spend()) break;
    if (path.length < 3 || path.length > maxStages + 1) continue;
    const key = path[0].toLowerCase();
    const token = tokenByAddress.get(key);
    const gasCost = splitGasCost(costs, path[0]);
    if (!token || token.minProfit < 0n || gasCost === null ||
        key !== path.at(-1)!.toLowerCase() ||
        new Set(path.slice(0, -1).map(token => token.toLowerCase())).size !== path.length - 1) continue;
    const pathKey = path.map(token => token.toLowerCase()).join(':');
    if (seen.has(pathKey)) continue;
    seen.add(pathKey);
    const options: number[][][] = [];
    for (let i = 0; i < path.length - 1; i++) {
      const edges = graph.splitEdgeIndexes(path[i], path[i + 1], alternatives, spend);
      const subsets: number[][] = [];
      // Try split topologies first; single endpoints are already covered by the baseline search.
      for (let x = 0; x < edges.length; x++) for (let y = x + 1; y < edges.length; y++) subsets.push([edges[x], edges[y]]);
      subsets.push(...edges.map(edge => [edge]));
      options.push(subsets);
    }
    const visit = (topology: number[][], used: Set<string>, protocols: Set<string>) => {
      if (exhausted || evaluated >= maxCandidates || !spend()) return;
      const stageIndex = topology.length;
      if (stageIndex < options.length) {
        for (const subset of options[stageIndex]) {
          if (topology.flat().length + subset.length > 6) continue;
          const nextUsed = new Set(used);
          const nextProtocols = new Set(protocols);
          let valid = true;
          for (const index of subset) {
            const edge = graph.edgeAt(index)!;
            nextProtocols.add(edge.protocol);
            for (const resource of liquidityResources(edge)) {
              if (nextUsed.has(resource)) valid = false;
              nextUsed.add(resource);
            }
          }
          if (!valid || (!graph.policy.allowProtocolMixing && nextProtocols.size > 1)) continue;
          visit([...topology, subset], nextUsed, nextProtocols);
          if (exhausted || evaluated >= maxCandidates) break;
        }
        return;
      }
      if (!topology.some(stage => stage.length > 1)) return;
      evaluated++;
      const maxInput = graph.maxInputForEdges(topology[0]);
      const pools = topology.flat().map(index => graph.edgeAt(index)!.poolAddress);
      let localBest: SplitCandidate | null = null;
      const evaluate = (amount: bigint) => {
        if (amount <= 0n || amount > maxInput || !spend()) return;
        const funding = graph.findBestFlashPoolForToken(path[0], amount, pools, spend);
        if (!funding) return;
        const allocations: SplitAllocation[][] = [];
        let available = amount;
        for (const subset of topology) {
          const allocation = allocateStage(graph, subset, available, spend, allocations.length === 0);
          if (!allocation) return;
          allocations.push(allocation.inputs);
          available = allocation.output;
        }
        const quote = quoteSplitStages(graph, path, allocations, slippageBps, spend);
        if (!quote) return;
        const profit = quote.amountOut - amount - flashLoanFee(funding, amount);
        const netProfit = profit - gasCost;
        const candidate: SplitCandidate = { path, quote, flashPool: funding, netProfit, gasCost,
          minSurplusAfterRepayment: (token.minProfit > gasCost ? token.minProfit : gasCost) + 1n };
        if (!localBest || netProfit > localBest.netProfit) localBest = candidate;
        const threshold = baselineNet.get(key) ?? 0n;
        if (profit <= token.minProfit || netProfit <= 0n || netProfit <= threshold) return;
        if (!winners.has(key) || netProfit > winners.get(key)!.netProfit) winners.set(key, candidate);
      };
      // Coarse grid plus geometric small inputs; no smoothness/unimodality assumption.
      for (let sample = 1; sample <= SAMPLES && !exhausted; sample++) evaluate(maxInput * BigInt(sample) / BigInt(SAMPLES));
      for (let amount = maxInput / 2n; amount > 0n && !exhausted; amount /= 2n) evaluate(amount);
      let radius = maxInput / BigInt(SAMPLES);
      for (let round = 0; round < REFINEMENTS && !exhausted && localBest; round++) {
        const center: bigint = (localBest as SplitCandidate).quote.amountIn;
        for (const offset of [-radius, -radius / 2n, -1n, 1n, radius / 2n, radius]) evaluate(center + offset);
        radius /= 2n;
      }
    };
    visit([], new Set(), new Set());
    if (exhausted || evaluated >= maxCandidates) break;
  }
  return result();
}

function allocateStage(graph: MarketGraph, edges: number[], amount: bigint, spend: () => boolean, capInputs: boolean) {
  const { slippageBps } = EXECUTION_POLICY;
  const caps = capInputs ? edges.map(index => graph.maxInputForEdges([index])) : [];
  let best: { inputs: SplitAllocation[]; output: bigint; first: bigint } | null = null;
  const evaluate = (first: bigint) => {
    if (first <= 0n || first > amount || (edges.length === 2 && first === amount)) return;
    const inputs = edges.map((edgeIndex, i) => ({ edgeIndex, amountIn: i === 0 ? first : amount - first }));
    let output = 0n;
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      if ((capInputs && input.amountIn > caps[i]) || !spend()) return;
      let quote;
      try { quote = graph.quoteEdgeAt(input.edgeIndex, input.amountIn, spend); }
      catch { return; }
      if (!quote.complete) return;
      output += quote.amountOut * BigInt(10000 - slippageBps) / 10000n;
    }
    if (!best || output > best.output) best = { inputs, output, first };
  };
  if (edges.length === 1) evaluate(amount);
  else {
    if (capInputs) { evaluate(caps[0] < amount ? caps[0] : amount - 1n); evaluate(amount - caps[1]); }
    for (let i = 1; i < SAMPLES; i++) evaluate(amount * BigInt(i) / BigInt(SAMPLES));
    let radius = amount / BigInt(SAMPLES);
    for (let round = 0; round < REFINEMENTS && best; round++) {
      const center: bigint = (best as { first: bigint }).first;
      for (const offset of [-radius, -radius / 2n, -1n, 1n, radius / 2n, radius]) evaluate(center + offset);
      radius /= 2n;
    }
  }
  return best as { inputs: SplitAllocation[]; output: bigint; first: bigint } | null;
}
