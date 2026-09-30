import { MAX_TICK, MIN_TICK } from './quote';
import { type V3BitmapWord, type V3Snapshot } from './types';

export function tickWordBounds(tickSpacing: number) {
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0 || tickSpacing > 32767) throw new Error('Invalid V3 tick spacing');
  return {
    minWord: Math.floor(Math.ceil(MIN_TICK / tickSpacing) / 256),
    maxWord: Math.floor(Math.floor(MAX_TICK / tickSpacing) / 256),
  };
}

export function initializedTickIndexes(words: readonly V3BitmapWord[], tickSpacing: number): number[] {
  const result: number[] = [];
  for (const { wordPosition, bitmap } of words) {
    if (bitmap < 0n || bitmap >= 1n << 256n) throw new Error('Invalid V3 bitmap');
    for (let bit = 0; bit < 256; bit++) {
      if ((bitmap & (1n << BigInt(bit))) === 0n) continue;
      const tick = (wordPosition * 256 + bit) * tickSpacing;
      if (tick < MIN_TICK || tick > MAX_TICK) throw new Error('V3 bitmap contains an out-of-range tick');
      result.push(tick);
    }
  }
  return result;
}

export function validateSnapshot(snapshot: V3Snapshot, tickSpacing: number): void {
  const bounds = tickWordBounds(tickSpacing);
  if (!snapshot.complete || snapshot.minWord !== bounds.minWord || snapshot.maxWord !== bounds.maxWord) throw new Error('Incomplete V3 snapshot coverage');
  const positions = snapshot.bitmapWords.map(word => word.wordPosition);
  if (new Set(positions).size !== positions.length || positions.some(word => !Number.isInteger(word) || word < bounds.minWord || word > bounds.maxWord)) throw new Error('Invalid V3 word coverage');
  const indexes = initializedTickIndexes(snapshot.bitmapWords, tickSpacing).sort((a, b) => a - b);
  const ticks = [...snapshot.ticks].sort((a, b) => a.index - b.index);
  if (indexes.length !== ticks.length || indexes.some((index, i) => ticks[i].index !== index || ticks[i].liquidityGross <= 0n || abs(ticks[i].liquidityNet) > ticks[i].liquidityGross)) {
    throw new Error('V3 tick records do not match the bitmap');
  }
  let cumulative = 0n;
  let active = 0n;
  for (const tick of ticks) {
    cumulative += tick.liquidityNet;
    if (cumulative < 0n || cumulative >= 1n << 128n) throw new Error('Invalid V3 range liquidity');
    if (tick.index <= snapshot.tick) active = cumulative;
  }
  if (cumulative !== 0n || active !== snapshot.liquidity) throw new Error('V3 live liquidity does not match its complete tick range');
}

function abs(value: bigint) { return value < 0n ? -value : value; }
