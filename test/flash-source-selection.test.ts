import { expect, test } from 'bun:test';
import { ARBITRAGE_SEARCH_POLICY, TOKENS } from '../src/constants';
import { MarketGraph } from '../src/market-graph/market-graph';
import { address } from './helpers/v3-fixture';

test('cached flash-source ordering matches exhaustive selection across amounts and exclusions', () => {
  const graph = new MarketGraph({ ...ARBITRAGE_SEARCH_POLICY, allowedProtocols: ['v2'] });
  const token = TOKENS[0].address;
  for (const [id, fee, reserve] of [[1, 30, 1_000_000], [2, 15, 100], [3, 17, 1_000_000], [4, 15, 1_000_000]] as const) {
    graph.addPair({ pairAddress: address(id), token0: token, token1: address(id + 100),
      reserve0: BigInt(reserve), reserve1: BigInt(reserve), fee, variant: 'uniswap-v2', scale0: 1n, scale1: 1n });
  }
  for (const amount of [1n, 99n, 100n, 100_000n, 1_000_000n]) {
    for (const excluded of [[], [address(4)], [address(2), address(4)]]) {
      expect(graph.findBestFlashPoolForToken(token, amount, excluded))
        .toEqual(graph.findBestFlashPoolForToken(token, amount, excluded, () => true));
    }
  }
  graph.updateReserves([{ pairAddress: address(4), reserve0: 0n, reserve1: 0n }]);
  for (const amount of [1n, 99n, 100n, 100_000n]) {
    expect(graph.findBestFlashPoolForToken(token, amount))
      .toEqual(graph.findBestFlashPoolForToken(token, amount, [], () => true));
  }
});
