import { expect, test } from 'bun:test';
import { ARBITRAGE_SEARCH_POLICY } from '../src/constants';
import { enabledProtocolPlugins, PROTOCOL_PLUGINS, protocolPlugin } from '../src/protocols/registry';

test('protocol registry keeps dependency-safe discovery order', () => {
  expect(PROTOCOL_PLUGINS.map(plugin => plugin.id)).toEqual(['v2', 'v3', 'carbon']);
});

test('protocol selection follows the constant without changing registrations', () => {
  const previous = ARBITRAGE_SEARCH_POLICY.allowedProtocols;
  try {
    ARBITRAGE_SEARCH_POLICY.allowedProtocols = ['v2'];
    expect(enabledProtocolPlugins().map(plugin => plugin.id)).toEqual(['v2']);
    expect(protocolPlugin('v3').contractId).toBe(1);
    expect(protocolPlugin('carbon').contractId).toBe(2);
  } finally {
    ARBITRAGE_SEARCH_POLICY.allowedProtocols = previous;
  }
});

test('protocol selection preserves dependency order and removes duplicates', () => {
  expect(enabledProtocolPlugins(['carbon', 'v3', 'v2', 'v2']).map(plugin => plugin.id))
    .toEqual(['v2', 'v3', 'carbon']);
  expect(enabledProtocolPlugins(['carbon', 'v3']).map(plugin => plugin.id))
    .toEqual(['v3', 'carbon']);
  expect(enabledProtocolPlugins(['carbon']).map(plugin => plugin.id)).toEqual(['carbon']);
});

test('an empty protocol selection reports the setting to fix', () => {
  expect(() => enabledProtocolPlugins([])).toThrow('ARBITRAGE_SEARCH_POLICY.allowedProtocols');
});
