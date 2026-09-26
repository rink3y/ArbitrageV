import { type Address } from 'viem';

export type V3PoolConfig = {
  name: string;
  address: Address;
  token0: Address;
  token1: Address;
  fee: number;
  tickSpacing: number;
  enabled: boolean;
};

export type V3FactoryConfig = {
  name: string;
  address: Address;
  fromBlock: bigint;
  enabled: boolean;
};

export type V3PoolMetadata = V3PoolConfig & {
  factory: Address;
  creationBlock: bigint;
  minWord: number;
  maxWord: number;
};

export type V3Snapshot = V3PoolState & {
  poolAddress: Address;
  blockNumber: bigint;
  blockHash: `0x${string}`;
  minWord: number;
  maxWord: number;
  // Every bitmap word in [minWord, maxWord] was read at blockNumber.
  // Empty words are implicit only after complete becomes true.
  complete: boolean;
  bitmapWords: V3BitmapWord[];
  ticks: V3Tick[];
};

export type V3PoolState = {
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
};

export type V3Tick = {
  index: number;
  liquidityGross: bigint;
  liquidityNet: bigint;
};

export type V3BitmapWord = {
  wordPosition: number;
  bitmap: bigint;
};

export type V3PoolInfo = V3PoolConfig & {
  state: V3PoolState | null;
  fullRange?: boolean;
  ticks: Map<number, V3Tick>;
  bitmapWords: Map<number, bigint>;
};

export type V3PoolUpdate = {
  poolAddress: Address;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
};

export type V3TickUpdate = {
  poolAddress: Address;
  ticks: V3Tick[];
};

export type V3SwapDirection = 'token0ToToken1' | 'token1ToToken0';
