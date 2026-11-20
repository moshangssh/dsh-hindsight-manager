import { isAbsolute } from 'node:path';
import { registerTests } from '../tests/runtime/settings.test.mjs';

const args = process.argv.slice(2);
if (args.length !== 1 || !isAbsolute(args[0])) {
  throw new Error('Usage: npm run test:runtime -- /absolute/path/to/prepared/hindsight-coding-agents');
}
await registerTests(args[0]);
