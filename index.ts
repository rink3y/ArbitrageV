import { runArbitrageBot } from './src/runtime/arbitrage-bot';
import { installLifecycle } from './src/reporting/lifecycle';

const lifecycle = installLifecycle();
runArbitrageBot(lifecycle.registerStop).catch(lifecycle.finish);
