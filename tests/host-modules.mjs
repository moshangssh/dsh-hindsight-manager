import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const executable = process.env.PATH.split(delimiter).map((path) => join(path, 'dsh')).find(existsSync);
assert.ok(executable, 'Install DSH to verify activity integration');
const host = createRequire(join(dirname(dirname(realpathSync(executable))), 'package.json'));
export const hostUrl = (name) => pathToFileURL(host.resolve(name)).href;
export const hostModule = (name) => import(hostUrl(name));
