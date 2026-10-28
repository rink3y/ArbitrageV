export type ChainCursor = {
  blockNumber: bigint;
  transactionIndex: number;
  logIndex: number;
};

export function compareChainLogs(left: any, right: any): number {
  const block = compareLogField(left.blockNumber, right.blockNumber);
  if (block !== 0) return block;
  const transaction = compareLogField(left.transactionIndex, right.transactionIndex);
  return transaction !== 0 ? transaction : compareLogField(left.logIndex, right.logIndex);
}

export function chainLogBlockNumber(log: any): bigint {
  return logFieldToBigInt(log.blockNumber);
}

export function isLogAfterCursor(log: any, cursor: ChainCursor): boolean {
  const block = logFieldToBigInt(log.blockNumber);
  if (block !== cursor.blockNumber) return block > cursor.blockNumber;
  const transaction = logFieldToNumber(log.transactionIndex);
  return transaction !== cursor.transactionIndex
    ? transaction > cursor.transactionIndex
    : logFieldToNumber(log.logIndex) > cursor.logIndex;
}

export function advanceCursor(cursor: ChainCursor | undefined, log: any): ChainCursor {
  if (!cursor) {
    return {
      blockNumber: logFieldToBigInt(log.blockNumber),
      transactionIndex: logFieldToNumber(log.transactionIndex),
      logIndex: logFieldToNumber(log.logIndex),
    };
  }
  cursor.blockNumber = logFieldToBigInt(log.blockNumber);
  cursor.transactionIndex = logFieldToNumber(log.transactionIndex);
  cursor.logIndex = logFieldToNumber(log.logIndex);
  return cursor;
}

function compareLogField(left: unknown, right: unknown): number {
  const a = logFieldToBigInt(left);
  const b = logFieldToBigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function logFieldToBigInt(value: unknown): bigint {
  return typeof value === 'bigint' ? value : BigInt(typeof value === 'number' ? value : 0);
}

function logFieldToNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(typeof value === 'bigint' ? value : 0);
}
