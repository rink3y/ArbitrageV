import { type Address, type PublicClient } from 'viem';
import UniswapFlashQueryABI from '../../ABI/UniswapFlashQuery.json';
import { CONTRACTS, RUNTIME, TOKENS } from '../../constants';
import { CARBON_CONTROLLERS, CARBON_STARTUP_POLICY } from './config';
import { graphToken } from '../../tokens';
import { type ProtocolEventAdapter } from '../../runtime/protocol-event-adapter';
import { CARBON_CONTROLLER_EVENT_ABI } from './events';
import { carbonStrategyKey, type CarbonOrder, type CarbonPairMetadata, type CarbonStrategy, type CarbonStrategyId, type CarbonUpdate } from './types';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

type CarbonClient = {
  readContract(parameters: any): Promise<unknown>;
};

type RawCarbonStrategy = {
  id?: bigint;
  owner?: Address;
  tokens?: readonly [Address, Address];
  orders?: readonly [RawCarbonOrder, RawCarbonOrder];
  0?: bigint;
  1?: Address;
  2?: readonly [Address, Address];
  3?: readonly [RawCarbonOrder, RawCarbonOrder];
};

type RawCarbonOrder = {
  y?: bigint;
  z?: bigint;
  A?: bigint;
  B?: bigint;
  0?: bigint;
  1?: bigint;
  2?: bigint;
  3?: bigint;
};

type RawCarbonPairStrategies = {
  feePpm?: number;
  strategies?: RawCarbonStrategy[];
  2?: number;
  3?: RawCarbonStrategy[];
};

export class CarbonStrategyStore {
  private readonly strategiesById = new Map<string, CarbonStrategy>();
  private readonly strategyIdsByPair = new Map<string, Set<string>>();
  private readonly pairByTokenKey = new Map<string, CarbonPairMetadata>();
  private readonly activePairKeys = new Set<string>();

  constructor(
    private readonly client: CarbonClient,
    private readonly pairs: readonly CarbonPairMetadata[],
    private readonly onChange?: (
      update: CarbonUpdate,
      changedPoolKeys: readonly string[],
      changedController?: Address
    ) => void | Promise<void>
  ) {
    for (const pair of pairs) {
      const key = this.pairKey(pair.controller, pair.token0, pair.token1);
      this.pairByTokenKey.set(key, pair);
      this.pairByTokenKey.set(this.pairKey(pair.controller, pair.token1, pair.token0), pair);
      this.strategyIdsByPair.set(key, new Set());
    }
  }

  stats(): { pairCount: number; strategyCount: number } {
    return {
      pairCount: this.activePairKeys.size,
      strategyCount: this.strategiesById.size,
    };
  }

  async loadAll(): Promise<void> {
    this.strategiesById.clear();
    this.activePairKeys.clear();
    for (const ids of this.strategyIdsByPair.values()) ids.clear();

    if (!CONTRACTS.flashQuery) {
      throw new Error('UNISWAP_FLASH_QUERY_CONTRACT_ADDRESS is required to batch load Carbon strategies.');
    }

    await this.refetchPairsInBatches();

    if (RUNTIME.debug) console.log(`Carbon loaded ${this.strategiesById.size} live strategies`);
    await this.onChange?.({ kind: 'snapshot', strategies: [...this.strategiesById.values()] }, []);
  }

  async handleEvents(controller: Address, logs: any[]): Promise<void> {
    const changedPoolKeys = new Set<string>();
    const changed = new Map<string, CarbonStrategyId>();

    for (const log of logs) {
      const poolKeys = this.applyEvent(controller, log as any);
      if (!poolKeys) continue;
      const ref = { controller, id: BigInt(log.args.id) };
      changed.set(carbonStrategyKey(ref), ref);
      for (const key of poolKeys) changedPoolKeys.add(key);
    }

    if (changed.size === 0) return;
    const upserts: CarbonStrategy[] = [];
    const removed: CarbonStrategyId[] = [];
    for (const [key, ref] of changed) {
      const strategy = this.strategiesById.get(key);
      if (strategy) upserts.push(strategy);
      else removed.push(ref);
    }
    await this.onChange?.({ kind: 'delta', upserts, removed }, [...changedPoolKeys], controller);
  }

  private async refetchPairsInBatches(): Promise<void> {
    for (const [controller, pairs] of this.pairsByController()) {
      if (RUNTIME.debug) {
        const batchCount = Math.ceil(pairs.length / CARBON_STARTUP_POLICY.batchSize);
        console.log(`Loading ${pairs.length} Carbon pairs from ${controller} in ${batchCount} batches of up to ${CARBON_STARTUP_POLICY.batchSize}`);
      }

      for (let start = 0; start < pairs.length; start += CARBON_STARTUP_POLICY.batchSize) {
        const batch = pairs.slice(start, start + CARBON_STARTUP_POLICY.batchSize);
        if (RUNTIME.debug) {
          console.log(`Carbon strategy batch ${Math.floor(start / CARBON_STARTUP_POLICY.batchSize) + 1}: ${batch.length} pairs`);
        }
        await this.refetchPairBatch(batch);
      }
    }
  }

  private async refetchPairBatch(pairs: readonly CarbonPairMetadata[]): Promise<void> {
    if (pairs.length === 0) return;
    const controller = pairs[0].controller;

    const results = await this.client.readContract({
      address: CONTRACTS.flashQuery as Address,
      abi: UniswapFlashQueryABI,
      functionName: 'getCarbonStrategiesByPairs',
      args: [
        controller,
        pairs.map(pair => ({
          token0: pair.token0,
          token1: pair.token1,
          startIndex: 0n,
          endIndex: 0n,
        })),
      ],
    }) as RawCarbonPairStrategies[];

    for (let index = 0; index < pairs.length; index++) {
      const result = results[index];
      const feePpm = result ? field<number | undefined>(result, 'feePpm', 2) : undefined;
      if (feePpm !== undefined) {
        pairs[index].feePpm = Number(feePpm);
      }

      this.applyRawStrategiesForPair(
        pairs[index],
        result ? field<RawCarbonStrategy[]>(result, 'strategies', 3) ?? [] : []
      );
    }
  }

  private applyRawStrategiesForPair(pair: CarbonPairMetadata, rawStrategies: RawCarbonStrategy[]): void {
    const key = this.pairKey(pair.controller, pair.token0, pair.token1);
    const previousIds = this.strategyIdsByPair.get(key);
    if (previousIds) {
      for (const id of previousIds) this.strategiesById.delete(id);
      previousIds.clear();
    }

    const ids = previousIds ?? new Set<string>();
    let filtered = 0;
    for (const raw of rawStrategies) {
      const strategy = this.normalizeStrategy(pair.controller, raw);
      strategy.feePpm = pair.feePpm;
      this.applyOrderFilters(strategy);
      if (!this.isLiveStrategy(strategy)) {
        filtered++;
        continue;
      }
      const id = carbonStrategyKey(strategy);
      this.strategiesById.set(id, strategy);
      ids.add(id);
    }
    this.strategyIdsByPair.set(key, ids);
    this.setPairActive(key, ids.size > 0);

    if (RUNTIME.debug) {
      console.log(`Carbon pair ${pair.token0}/${pair.token1}: loaded ${rawStrategies.length}, kept ${ids.size}, filtered ${filtered}`);
    }
  }

  private pairsByController(): Map<string, CarbonPairMetadata[]> {
    const pairsByController = new Map<string, CarbonPairMetadata[]>();
    for (const pair of this.pairs) {
      const key = pair.controller.toLowerCase();
      const pairs = pairsByController.get(key) ?? [];
      pairs.push(pair);
      pairsByController.set(key, pairs);
    }
    return pairsByController;
  }

  private applyEvent(controller: Address, log: { eventName?: string; args?: any }): string[] | null {
    const args = log.args;
    if (!args || !args.token0 || !args.token1) return null;

    if (!this.pairByTokenKey.has(this.pairKey(controller, args.token0, args.token1))) {
      return null;
    }

    const prefix = controller.toLowerCase();
    const strategyId = BigInt(args.id).toString();
    const poolKeys = [
      `carbon:${prefix}:${strategyId}`,
      `carbon-group:${prefix}:${args.token0.toLowerCase()}:${args.token1.toLowerCase()}`,
      `carbon-group:${prefix}:${args.token1.toLowerCase()}:${args.token0.toLowerCase()}`,
    ];

    if (log.eventName === 'StrategyDeleted') {
      this.deleteStrategy({ controller, id: BigInt(args.id) });
      return poolKeys;
    }

    if (log.eventName === 'StrategyCreated' || log.eventName === 'StrategyUpdated') {
      const key = carbonStrategyKey({ controller, id: BigInt(args.id) });
      const existing = this.strategiesById.get(key);
      const strategy: CarbonStrategy = {
        id: BigInt(args.id),
        owner: args.owner ?? existing?.owner ?? ZERO_ADDRESS,
        controller,
        token0: args.token0,
        token1: args.token1,
        feePpm: existing?.feePpm ?? this.feePpmForPair(controller, args.token0, args.token1),
        orders: [this.normalizeOrder(args.order0), this.normalizeOrder(args.order1)],
      };

      this.applyOrderFilters(strategy);
      if (this.isLiveStrategy(strategy)) {
        this.strategiesById.set(key, strategy);
        this.addStrategyToPair(strategy);
      } else {
        this.deleteStrategy(strategy);
      }
      return poolKeys;
    }

    return null;
  }

  private addStrategyToPair(strategy: CarbonStrategy): void {
    const key = this.canonicalPairKey(this.pairKey(strategy.controller, strategy.token0, strategy.token1));
    let ids = this.strategyIdsByPair.get(key);
    if (!ids) {
      ids = new Set();
      this.strategyIdsByPair.set(key, ids);
    }
    ids.add(carbonStrategyKey(strategy));
    this.setPairActive(key, true);
  }

  private deleteStrategy(ref: CarbonStrategyId): void {
    const key = carbonStrategyKey(ref);
    const strategy = this.strategiesById.get(key);
    if (!strategy) return;
    this.strategiesById.delete(key);
    const pairKey = this.canonicalPairKey(this.pairKey(strategy.controller, strategy.token0, strategy.token1));
    const ids = this.strategyIdsByPair.get(pairKey)!;
    ids.delete(key);
    if (ids.size === 0) this.setPairActive(pairKey, false);
  }

  private normalizeStrategy(controller: Address, raw: RawCarbonStrategy): CarbonStrategy {
    const tokens = field<readonly [Address, Address]>(raw, 'tokens', 2);
    const orders = field<readonly [RawCarbonOrder, RawCarbonOrder]>(raw, 'orders', 3);
    return {
      id: BigInt(field<bigint>(raw, 'id', 0)),
      owner: field<Address>(raw, 'owner', 1),
      controller,
      token0: tokens[0],
      token1: tokens[1],
      feePpm: this.feePpmForPair(controller, tokens[0], tokens[1]),
      orders: [this.normalizeOrder(orders[0]), this.normalizeOrder(orders[1])],
    };
  }

  private normalizeOrder(raw: RawCarbonOrder): CarbonOrder {
    return {
      y: BigInt(field<bigint>(raw, 'y', 0)),
      z: BigInt(field<bigint>(raw, 'z', 1)),
      A: BigInt(field<bigint>(raw, 'A', 2)),
      B: BigInt(field<bigint>(raw, 'B', 3)),
    };
  }

  private isLiveStrategy(strategy: CarbonStrategy): boolean {
    return strategy.orders[0].y > 0n || strategy.orders[1].y > 0n;
  }

  private applyOrderFilters(strategy: CarbonStrategy): void {
    if (!this.orderHasEnoughLiquidity(strategy.orders[0], strategy.token0)) strategy.orders[0].y = 0n;
    if (!this.orderHasEnoughLiquidity(strategy.orders[1], strategy.token1)) strategy.orders[1].y = 0n;
  }

  private orderHasEnoughLiquidity(order: CarbonOrder, targetToken: Address): boolean {
    if (order.y <= 0n) return false;
    const token = TOKENS.find(config => config.address.toLowerCase() === graphToken(targetToken).toLowerCase());
    return !token || order.y >= token.liquidityAmount;
  }

  private pairKey(controller: Address, token0: Address, token1: Address): string {
    return `${controller.toLowerCase()}:${token0.toLowerCase()}:${token1.toLowerCase()}`;
  }

	  private setPairActive(key: string, active: boolean): void {
	    const forwardKey = this.canonicalPairKey(key);
	    const pair = this.pairByTokenKey.get(forwardKey);
	    if (!pair) return;
	
	    if (active) {
	      this.activePairKeys.add(forwardKey);
	    } else {
      this.activePairKeys.delete(forwardKey);
    }
  }

  private canonicalPairKey(key: string): string {
    const pair = this.pairByTokenKey.get(key);
    return pair ? this.pairKey(pair.controller, pair.token0, pair.token1) : key;
  }

  private feePpmForPair(controller: Address, token0: Address, token1: Address): number {
    return this.pairByTokenKey.get(this.pairKey(controller, token0, token1))?.feePpm ?? 0;
  }
}

function field<TValue>(value: any, name: string, index: number): TValue {
  if (value && typeof value === 'object' && name in value) return value[name] as TValue;
  return value[index] as TValue;
}

export class CarbonEventAdapter implements ProtocolEventAdapter {
  readonly id = 'carbon';
  private readonly controllerAddresses = CARBON_CONTROLLERS
    .filter(controller => controller.enabled)
    .map(controller => controller.address);
  private readonly controllers = new Set(this.controllerAddresses.map(address => address.toLowerCase()));

  constructor(private readonly store: CarbonStrategyStore) {}

  addresses(): readonly Address[] {
    return this.controllerAddresses;
  }

  owns(address: Address): boolean {
    return this.controllers.has(address.toLowerCase());
  }

  async watch(client: PublicClient, onLogs: (logs: any[]) => void | Promise<void>, onError: (error: any) => void | Promise<void>) {
    if (this.controllerAddresses.length === 0) return [];
    const unwatch = await client.watchContractEvent({
      address: this.controllerAddresses,
      abi: CARBON_CONTROLLER_EVENT_ABI,
      strict: true,
      onLogs,
      onError,
    });
    return [unwatch];
  }

  bufferKey(log: any): string | null {
    const key = log.address?.toLowerCase();
    return key && this.controllers.has(key) ? key : null;
  }

  async reconcile(logs: readonly any[]): Promise<void> {
    const addresses: Address[] = [];
    for (const log of logs) {
      if (log.address) addresses.push(log.address);
    }
    await this.reconcileAddresses(addresses);
  }

  async reconcileAddresses(addresses: readonly Address[]): Promise<void> {
    if (addresses.some(address => this.owns(address))) await this.store.loadAll();
  }

  async apply(logs: any[]): Promise<void> {
    const byController = new Map<string, any[]>();
    for (const log of logs) {
      const key = log.address?.toLowerCase();
      if (!key || !this.controllers.has(key)) continue;
      const group = byController.get(key);
      if (group) group.push(log);
      else byController.set(key, [log]);
    }
    await Promise.all([...byController].map(([controller, controllerLogs]) =>
      this.store.handleEvents(controller as Address, controllerLogs)));
  }
}
