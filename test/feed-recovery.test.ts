import { expect, test } from 'bun:test';
import { EventMonitor } from '../src/runtime/event-monitor';
import { type ProtocolEventAdapter } from '../src/runtime/protocol-event-adapter';

test('feed errors pause candidate acceptance immediately and shutdown cancels delayed reconnect', async () => {
  let error!: (error: Error) => void | Promise<void>;
  let watches = 0;
  const ready: boolean[] = [];
  const adapter: ProtocolEventAdapter = { id: 'test', addresses: () => [], owns: () => false,
    bufferKey: () => null, reconcile: async () => {}, reconcileAddresses: async () => {}, apply: async () => {},
    watch: async (_client, _logs, onError) => { watches++; error = onError; return []; } };
  const monitor = new EventMonitor({ client: {} }, [adapter], value => { ready.push(value); });
  await monitor.startBuffering();
  await monitor.activate();
  expect(ready.at(-1)).toBe(true);
  const recovery = error(new Error('provider rate limit'));
  expect(ready.at(-1)).toBe(false);
  await monitor.stop();
  await recovery;
  expect(watches).toBe(1);
  expect(ready.at(-1)).toBe(false);
}, 5_000);

test('recovery during initial subscription does not activate trading before hydration', async () => {
  let watches = 0;
  const ready: boolean[] = [];
  const adapter: ProtocolEventAdapter = { id: 'test', addresses: () => [], owns: () => false,
    bufferKey: () => null, reconcile: async () => {}, reconcileAddresses: async () => {}, apply: async () => {},
    watch: async () => { if (++watches === 1) throw new Error('websocket unavailable'); return []; } };
  const monitor = new EventMonitor({ client: { getBlockNumber: async () => 1n }, wsClient: {} }, [adapter], value => { ready.push(value); });
  try {
    await monitor.startBuffering();
    expect(watches).toBe(2);
    expect(ready.includes(true)).toBe(false);
    await monitor.activate(1n);
    expect(ready.at(-1)).toBe(true);
  } finally { await monitor.stop(); }
}, 5_000);
