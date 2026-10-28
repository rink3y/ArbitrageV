import bannedTokens from './bannedtax.json';
import { type V2PoolMetadata } from './protocols/v2/metadata';
import { type CarbonPairMetadata } from './protocols/carbon/types';
import { type V3PoolConfig } from './protocols/v3/types';
import { graphToken, isNativeWrapper } from './tokens';

type Address = `0x${string}`;

export type MarketTokens = {
  token0: Address;
  token1: Address;
};

export type FilteredMarkets = {
  v2Pools: V2PoolMetadata[];
  v3Pools: V3PoolConfig[];
  carbonPairs: CarbonPairMetadata[];
};

const bannedTokenSet = new Set(bannedTokens.map(token => token.toLowerCase()));

export function filterDiscoveredMarkets(
  v2Pools: readonly V2PoolMetadata[],
  v3Pools: readonly V3PoolConfig[],
  carbonPairs: readonly CarbonPairMetadata[]
): FilteredMarkets {
  const withoutBanned = {
    v2Pools: v2Pools.filter(hasNoBannedToken),
    v3Pools: v3Pools.filter(hasNoBannedToken),
    carbonPairs: carbonPairs.filter(hasNoBannedToken),
  };
  const tokenUseCount = new Map<string, number>();

  for (const market of [
    ...withoutBanned.v2Pools,
    ...withoutBanned.v3Pools,
    ...withoutBanned.carbonPairs,
  ]) {
    for (const token of new Set([canonicalToken(market.token0), canonicalToken(market.token1)])) {
      tokenUseCount.set(token, (tokenUseCount.get(token) ?? 0) + 1);
    }
  }

  const filtered = {
    v2Pools: withoutBanned.v2Pools.filter(market => hasReusableTokens(market, tokenUseCount)),
    v3Pools: withoutBanned.v3Pools.filter(market => hasReusableTokens(market, tokenUseCount)),
    carbonPairs: withoutBanned.carbonPairs.filter(market => hasReusableTokens(market, tokenUseCount)),
  };

  return filtered;
}

export function marketTokens(
  ...marketGroups: Array<readonly (MarketTokens & Record<string, unknown>)[]>
): Address[] {
  const tokens = new Map<string, Address>();

  for (const market of marketGroups.flat()) {
    for (const token of [market.token0, market.token1]) {
      const canonical = graphToken(token);
      tokens.set(canonical.toLowerCase(), canonical);
    }
  }

  return Array.from(tokens.values());
}

function hasNoBannedToken(market: MarketTokens): boolean {
  return !isBannedToken(market.token0) && !isBannedToken(market.token1);
}

function isBannedToken(token: Address): boolean {
  return bannedTokenSet.has(token.toLowerCase()) || bannedTokenSet.has(canonicalToken(token));
}

function hasReusableTokens(market: MarketTokens, tokenUseCount: ReadonlyMap<string, number>): boolean {
  if (isNativeWrapper(market.token0) && isNativeWrapper(market.token1)) return true;
  return (tokenUseCount.get(canonicalToken(market.token0)) ?? 0) > 1 &&
    (tokenUseCount.get(canonicalToken(market.token1)) ?? 0) > 1;
}

function canonicalToken(token: Address): string {
  return graphToken(token).toLowerCase();
}
