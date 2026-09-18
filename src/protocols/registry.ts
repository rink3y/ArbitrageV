import { ARBITRAGE_SEARCH_POLICY } from '../constants';
import { createCarbonPlugin } from './carbon';
import { type ProtocolPlugin } from './protocol-plugin';
import { v2Plugin } from './v2';
import { v3Plugin } from './v3';

// Discovery order is intentional: Carbon limits itself to the V2/V3 token universe.
export const PROTOCOL_PLUGINS: readonly ProtocolPlugin[] = [v2Plugin, v3Plugin, createCarbonPlugin()];

const PLUGIN_BY_ID = new Map(PROTOCOL_PLUGINS.map(plugin => [plugin.id, plugin]));

export function enabledProtocolPlugins(
  allowedProtocols = ARBITRAGE_SEARCH_POLICY.allowedProtocols
): readonly ProtocolPlugin[] {
  const plugins = PROTOCOL_PLUGINS.filter(plugin => allowedProtocols.includes(plugin.id));
  if (plugins.length === 0) {
    throw new Error('Enable at least one protocol in ARBITRAGE_SEARCH_POLICY.allowedProtocols.');
  }
  return plugins;
}

export function protocolPlugin(id: ProtocolPlugin['id']): ProtocolPlugin {
  const plugin = PLUGIN_BY_ID.get(id);
  if (!plugin) throw new Error(`Protocol plugin is not registered: ${id}`);
  return plugin;
}
