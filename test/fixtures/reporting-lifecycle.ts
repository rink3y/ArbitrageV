import { RUNTIME, TELEGRAM } from '../../src/constants';
import { installLifecycle } from '../../src/reporting/lifecycle';
import { logger } from '../../src/reporting/logger';

Object.assign(TELEGRAM, { botToken: '', chatId: '' });
RUNTIME.logLevel = process.argv[2] === 'off' ? 'off' : 'debug';
RUNTIME.reportingShutdownMs = 1000;
const lifecycle = installLifecycle();
lifecycle.registerStop(() => { logger.info('SUBMISSIONS_STOPPED'); });
logger.info('Fixture started');
if (process.argv[3] === 'flood') {
  for (let i = 0; i < 10_000; i++) logger.info('x'.repeat(2048));
}
if (process.argv[3] === 'fatal') throw new Error('fixture fatal https://private.rpc/credential 0x' + '1'.repeat(64));
await lifecycle.finish();
