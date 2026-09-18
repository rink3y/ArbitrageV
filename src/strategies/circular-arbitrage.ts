import { type Address } from 'viem';
import { MarketGraph } from '../market-graph/market-graph';
import { type ArbitrageSearchPolicy, type MarketProtocol } from '../market-graph/types';
import { transitionAllowed } from '../market-graph/types';
import {
  type CandidateRoute,
  type FindOpportunitiesRequest,
} from '../opportunities/opportunity-types';
import { compareFractions } from '../fractions';

type RouteStateStore = {
  tokenIndexes: number[];
  originTokenIndexes: number[];
  previousIndexes: number[];
  viaEdgeIndexes: number[];
  depths: number[];
  rateNumerators: bigint[];
  rateDenominators: bigint[];
};

const NO_STATE = -1;
const NO_EDGE = -1;
type CandidateVisitor = (candidate: CandidateRoute) => void;

export class CircularArbitrageStrategy {
  constructor(
    private readonly graph: MarketGraph,
    private readonly policy: ArbitrageSearchPolicy
  ) {}

  visitCandidates(request: FindOpportunitiesRequest, visit: CandidateVisitor): void {
    const changedPoolIndexes = this.changedPoolIndexes(request.changedPairs || []);
    const startTokenIndexes = request.startTokens
      .map(token => this.graph.tokenIndexOf(token))
      .filter((tokenIndex): tokenIndex is number => tokenIndex !== undefined);
    const states = this.createStateStore();
    const statesByStep: Record<number, Map<number, number[]>> = {};

    statesByStep[0] = new Map();
    for (const startTokenIndex of startTokenIndexes) {
      const stateIndex = this.pushState(states, {
        tokenIndex: startTokenIndex,
        originTokenIndex: startTokenIndex,
        previousIndex: NO_STATE,
        viaEdgeIndex: NO_EDGE,
        depth: 0,
        rateNumerator: 1n,
        rateDenominator: 1n,
      });
      statesByStep[0].set(this.stateKey(startTokenIndex, startTokenIndex, null), [stateIndex]);
    }

    for (let step = 1; step <= this.policy.maxRouteEdges; step++) {
      statesByStep[step] = new Map();
      let expanded = false;

      for (const stateIndexes of statesByStep[step - 1].values()) {
        const currentTokenIndex = states.tokenIndexes[stateIndexes[0]];
        const rankedEdgeIndexes = this.graph.rankedEdgeIndexes(currentTokenIndex, this.policy.beamWidth);

        for (const stateIndex of stateIndexes) {
          let accepted = 0;
          let consideredEdgeIndexes = rankedEdgeIndexes;
          for (const edgeIndex of rankedEdgeIndexes) {
            const didExpand = this.expandEdge(
              states,
              stateIndex,
              edgeIndex,
              step,
              statesByStep[step],
              changedPoolIndexes,
              visit
            );
            if (didExpand) accepted++;
            expanded = didExpand || expanded;
          }

          if (accepted < this.policy.beamWidth) {
            consideredEdgeIndexes = this.graph.rankedEdgeIndexes(
              currentTokenIndex,
              this.policy.beamWidth + this.policy.maxRouteEdges
            );
            for (let index = rankedEdgeIndexes.length; index < consideredEdgeIndexes.length; index++) {
              const didExpand = this.expandEdge(
                states,
                stateIndex,
                consideredEdgeIndexes[index],
                step,
                statesByStep[step],
                changedPoolIndexes,
                visit
              );
              if (didExpand) accepted++;
              expanded = didExpand || expanded;
              if (accepted >= this.policy.beamWidth) break;
            }
          }

          for (const poolIndex of changedPoolIndexes) {
            const affectedEdgeIndexes = this.graph.edgeIndexesForTokenPool(currentTokenIndex, poolIndex);
            for (const edgeIndex of affectedEdgeIndexes) {
              if (consideredEdgeIndexes.includes(edgeIndex)) continue;

              expanded = this.expandEdge(
                states,
                stateIndex,
                edgeIndex,
                step,
                statesByStep[step],
                changedPoolIndexes,
                visit
              ) || expanded;
            }
          }
        }
      }

      if (!expanded) break;
    }
  }

  private expandEdge(
    states: RouteStateStore,
    entryIndex: number,
    edgeIndex: number,
    step: number,
    nextStep: Map<number, number[]>,
    changedPoolIndexes: Set<number>,
    visit: CandidateVisitor
  ): boolean {
    const edge = this.graph.edgeAt(edgeIndex);
    if (!edge) return false;
    const toTokenIndex = this.graph.edgeToTokenIndex(edgeIndex);
    const originTokenIndex = states.originTokenIndexes[entryIndex];
    if (!this.graph.canReachToken(toTokenIndex, originTokenIndex, this.policy.maxRouteEdges - step)) return false;
    if (!transitionAllowed(this.policy, this.previousProtocol(states, entryIndex), edge.protocol)) return false;
    if (this.hasPool(states, entryIndex, this.graph.edgePoolIndex(edgeIndex))) return false;
    if (!this.canStillYield(states, entryIndex, edgeIndex, step, changedPoolIndexes)) return false;

    const nextIndex = this.pushState(states, {
      tokenIndex: toTokenIndex,
      originTokenIndex,
      previousIndex: entryIndex,
      viaEdgeIndex: edgeIndex,
      depth: states.depths[entryIndex] + 1,
      rateNumerator: states.rateNumerators[entryIndex] * edge.rateNumerator,
      rateDenominator: states.rateDenominators[entryIndex] * edge.rateDenominator,
    });

    this.keepBestState(states, nextStep, nextIndex);

    if (step >= 2 && this.isRelevantCandidate(states, nextIndex, changedPoolIndexes)) {
      visit(this.toRoute(states, nextIndex));
    }

    return true;
  }

  private canStillYield(
    states: RouteStateStore,
    entryIndex: number,
    edgeIndex: number,
    step: number,
    changedPoolIndexes: Set<number>
  ): boolean {
    if (step !== this.policy.maxRouteEdges) return true;

    const toTokenIndex = this.graph.edgeToTokenIndex(edgeIndex);
    if (toTokenIndex !== states.originTokenIndexes[entryIndex]) return false;
    if (changedPoolIndexes.size === 0) return true;

    return changedPoolIndexes.has(this.graph.edgePoolIndex(edgeIndex)) ||
      this.hasChangedPool(states, entryIndex, changedPoolIndexes);
  }

  private keepBestState(
    store: RouteStateStore,
    step: Map<number, number[]>,
    stateIndex: number
  ): void {
    const key = this.stateKey(
      store.originTokenIndexes[stateIndex],
      store.tokenIndexes[stateIndex],
      this.previousProtocol(store, stateIndex)
    );
    if (!step.has(key)) {
      step.set(key, []);
    }

    const stateIndexes = step.get(key)!;
    stateIndexes.push(stateIndex);
    this.moveStateIntoRank(store, stateIndexes, stateIndexes.length - 1);
    stateIndexes.splice(this.policy.beamWidth);
  }

  private stateKey(originTokenIndex: number, tokenIndex: number, protocol: MarketProtocol | null): number {
    const protocolIndex = protocol === 'v2' ? 1 : protocol === 'v3' ? 2 : protocol === 'carbon' ? 3 : 0;
    return (originTokenIndex * this.graph.tokenCount() + tokenIndex) * 4 + protocolIndex;
  }

  private moveStateIntoRank(store: RouteStateStore, stateIndexes: number[], index: number): void {
    while (index > 0 && this.compareStateRank(store, stateIndexes[index], stateIndexes[index - 1]) > 0) {
      const previous = stateIndexes[index - 1];
      stateIndexes[index - 1] = stateIndexes[index];
      stateIndexes[index] = previous;
      index--;
    }
  }

  private compareStateRank(store: RouteStateStore, a: number, b: number): number {
    return compareFractions(
      store.rateNumerators[a],
      store.rateDenominators[a],
      store.rateNumerators[b],
      store.rateDenominators[b]
    );
  }

  private previousProtocol(states: RouteStateStore, stateIndex: number): MarketProtocol | null {
    const edgeIndex = states.viaEdgeIndexes[stateIndex];
    return edgeIndex === NO_EDGE ? null : this.graph.edgeAt(edgeIndex)?.protocol ?? null;
  }

  private hasPool(states: RouteStateStore, stateIndex: number, poolIndex: number): boolean {
    for (let current = stateIndex; current !== NO_STATE; current = states.previousIndexes[current]) {
      const edgeIndex = states.viaEdgeIndexes[current];
      if (edgeIndex !== NO_EDGE && this.graph.edgePoolIndex(edgeIndex) === poolIndex) return true;
    }
    return false;
  }

  private hasChangedPool(states: RouteStateStore, stateIndex: number, changedPoolIndexes: Set<number>): boolean {
    for (let current = stateIndex; current !== NO_STATE; current = states.previousIndexes[current]) {
      const edgeIndex = states.viaEdgeIndexes[current];
      if (edgeIndex !== NO_EDGE && changedPoolIndexes.has(this.graph.edgePoolIndex(edgeIndex))) return true;
    }
    return false;
  }

  private isRelevantCandidate(
    states: RouteStateStore,
    stateIndex: number,
    changedPoolIndexes: Set<number>
  ): boolean {
    if (states.rateNumerators[stateIndex] <= states.rateDenominators[stateIndex]) return false;

    if (changedPoolIndexes.size > 0 && !this.hasChangedPool(states, stateIndex, changedPoolIndexes)) {
      return false;
    }

    const originTokenIndex = states.originTokenIndexes[stateIndex];
    const targetTokenIndex = states.tokenIndexes[stateIndex];
    return targetTokenIndex === originTokenIndex;
  }

  private toRoute(states: RouteStateStore, stateIndex: number): CandidateRoute {
    const depth = states.depths[stateIndex];
    const path = new Array<Address>(depth + 1);
    const pairs = new Array<Address>(depth);
    const edgeIds = new Array<string>(depth);
    const edgeIndexes = new Array<number>(depth);
    const protocols = new Array<MarketProtocol>(depth);
    let current = stateIndex;

    for (let index = depth; index >= 0; index--) {
      path[index] = this.graph.tokenAddress(states.tokenIndexes[current]);

      if (index > 0) {
        const edgeIndex = states.viaEdgeIndexes[current];
        const edge = this.graph.edgeAt(edgeIndex)!;
        pairs[index - 1] = edge.poolAddress;
        edgeIds[index - 1] = edge.id;
        edgeIndexes[index - 1] = edgeIndex;
        protocols[index - 1] = edge.protocol;
        current = states.previousIndexes[current];
      }
    }

    return { path, pairs, edgeIds, edgeIndexes, protocols };
  }

  private createStateStore(): RouteStateStore {
    return {
      tokenIndexes: [],
      originTokenIndexes: [],
      previousIndexes: [],
      viaEdgeIndexes: [],
      depths: [],
      rateNumerators: [],
      rateDenominators: [],
    };
  }

  private pushState(
    states: RouteStateStore,
    state: {
      tokenIndex: number;
      originTokenIndex: number;
      previousIndex: number;
      viaEdgeIndex: number;
      depth: number;
      rateNumerator: bigint;
      rateDenominator: bigint;
    }
  ): number {
    const index = states.tokenIndexes.length;
    states.tokenIndexes.push(state.tokenIndex);
    states.originTokenIndexes.push(state.originTokenIndex);
    states.previousIndexes.push(state.previousIndex);
    states.viaEdgeIndexes.push(state.viaEdgeIndex);
    states.depths.push(state.depth);
    states.rateNumerators.push(state.rateNumerator);
    states.rateDenominators.push(state.rateDenominator);
    return index;
  }

  private changedPoolIndexes(changedPairs: readonly string[]): Set<number> {
    const indexes = new Set<number>();

    for (const pair of changedPairs) {
      const poolIndex = this.graph.poolIndexOf(pair);
      if (poolIndex !== undefined) indexes.add(poolIndex);
    }

    return indexes;
  }
}
