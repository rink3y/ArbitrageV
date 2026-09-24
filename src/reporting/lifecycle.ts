import { logger, startReporting, stopReporting } from './logger';
import { RUNTIME } from '../constants';

// A fatal error stops submission before any alert or asynchronous flush.
export function installLifecycle() {
  startReporting();
  let stop: () => void | Promise<void> = () => {};
  let closing = false;
  const finish = async (error?: unknown) => {
    if (closing) return;
    closing = true;
    let cleanup: Promise<unknown>;
    try { cleanup = Promise.resolve(stop()).catch(() => {}); } catch { cleanup = Promise.resolve(); }
    if (error !== undefined) logger.alert('process.fatal', 'error', 'Bot stopped after a fatal error', error);
    else logger.info('Stopping bot');
    const timeout = setTimeout(() => process.exit(error === undefined ? 0 : 1), RUNTIME.reportingShutdownMs + 100);
    await Promise.all([cleanup, stopReporting()]);
    clearTimeout(timeout);
    process.exit(error === undefined ? 0 : 1);
  };
  process.once('SIGINT', () => void finish());
  process.once('SIGTERM', () => void finish());
  process.once('uncaughtException', error => void finish(error));
  process.once('unhandledRejection', error => void finish(error ?? new Error('Unhandled rejection')));
  return { registerStop: (callback: () => void | Promise<void>) => {
    stop = callback;
    // Startup may finish warming the scanner while fatal reporting is flushing.
    if (closing) { try { void Promise.resolve(callback()).catch(() => {}); } catch {} }
  }, finish };
}
