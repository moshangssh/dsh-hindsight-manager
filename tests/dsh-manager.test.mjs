import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import * as manager from '../index.js';
import managerConfig from '../manager.config.json' with { type: 'json' };

const dshExecutable = process.env.PATH.split(delimiter).map((path) => join(path, 'dsh')).find(existsSync);
assert.ok(dshExecutable, 'Install DSH to verify the actual host lifecycle');
const hostModules = join(dirname(dirname(realpathSync(dshExecutable))), 'node_modules');
const { Context } = await import(pathToFileURL(join(hostModules, '@deepseek-ai/cordis/lib/index.js')));

async function fixture(t, initial) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-manager-test-'));
  const configPath = join(directory, 'coding-agent.json');
  if (initial) writeFileSync(configPath, JSON.stringify(initial));
  const ctx = new Context();
  ctx.provide('connection', { requestRejection() {} });
  const routes = new Map();
  ctx.provide('webServer', {
    register({ path, handler }) {
      assert.equal(routes.has(path), false, 'routes must not register twice');
      routes.set(path, handler);
      return () => routes.delete(path);
    },
  });
  // There is no agents/tools service and no official runtime in this host.
  let plugin = await ctx.plugin(manager, { configPath });
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return Response.json(String(url).includes('/documents') ? { items: [] } : { items: [{ bank_id: 'shared' }] });
  };
  t.after(async () => {
    await plugin.dispose();
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    configPath, directory, routes, requests,
    async request(action, method = 'GET', body) {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
      req.method = method;
      req.headers = {};
      let status;
      let result;
      await routes.get(`/plugins/dsh-hindsight-manager/${action}`)(req, {
        writeHead(value) { status = value; },
        end(value) { result = JSON.parse(value); },
      });
      return { status, body: result };
    },
    async reload() {
      await plugin.dispose();
      assert.equal(routes.size, 0);
      plugin = await ctx.plugin(manager, { configPath });
    },
  };
}

test('the manager loads without a memory runtime and reads inherited official settings', async (t) => {
  const f = await fixture(t, {
    apiUrl: 'http://memory.invalid', apiToken: 'test-token', optInOnly: true,
    mapPathToBank: { '/tmp': 'shared', '/missing-manager-test-directory': 'missing' },
    harnesses: { dsh: { retainSessions: false } },
  });
  assert.equal(f.routes.size, 4);
  assert.equal(f.requests.length, 0);
  const { status, body } = await f.request('state');
  assert.equal(status, 200);
  assert.equal(body.apiUrl, 'http://memory.invalid');
  assert.equal(body.optInOnly, true);
  assert.equal(body.retainSessions, false);
  assert.equal(body.apiTokenConfigured, true);
  assert.equal(body.apiToken, undefined);
  assert.equal(JSON.stringify(body).includes('test-token'), false);
  assert.deepEqual(body.positions, [
    { dir: '/tmp', bank: 'shared', exists: true },
    { dir: '/missing-manager-test-directory', bank: 'missing', exists: false },
  ]);
});

test('saving updates DSH settings while preserving other harnesses and advanced configuration', async (t) => {
  const initial = {
    serverMode: 'self-hosted', apiUrl: 'http://before.invalid', apiToken: 'global-token',
    mapPathToBank: { '/tmp': 'global-bank' },
    paths: { '/client': { apiUrl: 'http://client.invalid' } },
    banks: { shared: { gitIngest: 'none' } },
    harnesses: {
      dsh: { autoInject: 'pages', autoSeed: false, autoUpdate: false, customSetting: 'keep' },
      codex: { bankId: 'other-bank' },
    },
  };
  const f = await fixture(t, initial);
  const { status, body } = await f.request('save', 'POST', {
    apiUrl: 'http://after.invalid', positions: [{ dir: f.directory, bank: 'updated' }],
    optInOnly: true, retainSessions: false,
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.restartRequired, true);
  assert.match(body.note, /重启 DSH/);
  const saved = JSON.parse(readFileSync(f.configPath, 'utf8'));
  assert.deepEqual(saved, {
    ...initial,
    harnesses: {
      ...initial.harnesses,
      dsh: {
        ...initial.harnesses.dsh, apiUrl: 'http://after.invalid',
        mapPathToBank: { [f.directory]: 'updated' }, optInOnly: true, retainSessions: false,
      },
    },
  });
  assert.equal(f.requests.length, 0, 'saving settings must not start memory ingestion');
  await f.request('save', 'POST', { positions: [] });
  assert.deepEqual((await f.request('state')).body.positions, []);
});

test('a new installation reads explicit form defaults and writes config only on save', async (t) => {
  const f = await fixture(t);
  const { body } = await f.request('state');
  assert.equal(body.exists, false);
  assert.equal(body.apiUrl, managerConfig.formDefaults.apiUrl);
  assert.equal(body.optInOnly, managerConfig.formDefaults.optInOnly);
  assert.equal(existsSync(f.configPath), false);
  const saved = await f.request('save', 'POST', {
    apiUrl: 'http://memory.invalid', positions: [{ dir: f.directory, bank: 'new' }],
    optInOnly: true, retainSessions: true,
  });
  assert.equal(saved.body.ok, true);
  assert.equal(existsSync(f.configPath), true);
  await f.reload();
  assert.equal(f.routes.size, 4);
  assert.equal((await f.request('state')).body.positions[0].bank, 'new');
});

test('bank listing and connection testing use saved DSH credentials and pick up file edits', async (t) => {
  const f = await fixture(t, {
    apiUrl: 'http://global.invalid', apiToken: 'global-token',
    harnesses: { dsh: {
      apiUrl: 'http://dsh.invalid/', apiToken: 'dsh-token', mapPathToBank: { '/tmp': 'team/shared' },
    } },
  });
  assert.deepEqual((await f.request('banks')).body, { ok: true, banks: ['shared'] });
  const probe = (await f.request('test', 'POST')).body;
  assert.equal(probe.ok, true);
  assert.equal(probe.bank, 'team/shared');
  assert.deepEqual(f.requests.map(({ url }) => url), [
    'http://dsh.invalid/v1/default/banks',
    'http://dsh.invalid/v1/default/banks/team%2Fshared/documents?limit=1',
  ]);
  for (const { options } of f.requests) {
    assert.equal(options.headers.Authorization, 'Bearer dsh-token');
  }
  writeFileSync(f.configPath, JSON.stringify({
    apiUrl: 'http://updated.invalid', apiToken: 'updated-token',
  }));
  await f.request('banks');
  assert.equal(f.requests.at(-1).url, 'http://updated.invalid/v1/default/banks');
  assert.equal(f.requests.at(-1).options.headers.Authorization, 'Bearer updated-token');
});

test('daemon connection settings inherit the DSH port without starting a daemon', async (t) => {
  const f = await fixture(t, {
    serverMode: 'cloud', apiUrl: 'http://unused.invalid',
    harnesses: { dsh: { serverMode: 'daemon', apiPort: 12345 } },
  });
  assert.equal((await f.request('state')).body.apiUrl, 'http://127.0.0.1:12345');
  assert.equal(f.requests.length, 0);
  await f.request('banks');
  assert.equal(f.requests[0].url, 'http://127.0.0.1:12345/v1/default/banks');
});

test('changing the daemon URL selects self-hosted mode and uses the new service after reload', async (t) => {
  for (const initial of [
    { serverMode: 'daemon', apiPort: 12345 },
    { serverMode: 'cloud', harnesses: { dsh: { serverMode: 'daemon', apiPort: 12345 } } },
  ]) {
    await t.test(initial.harnesses ? 'DSH mode' : 'inherited mode', async (t) => {
      const f = await fixture(t, { ...initial, mapPathToBank: { '/tmp': 'shared' } });
      const { body } = await f.request('save', 'POST', { apiUrl: '  http://new-memory.invalid/  ' });
      assert.equal(body.ok, true);
      assert.equal(body.settings.serverMode, 'self-hosted');
      assert.equal(body.settings.apiUrl, 'http://new-memory.invalid/');
      assert.equal(JSON.parse(readFileSync(f.configPath, 'utf8')).harnesses.dsh.serverMode, 'self-hosted');
      await f.reload();
      assert.equal((await f.request('state')).body.apiUrl, 'http://new-memory.invalid/');
      await f.request('banks');
      await f.request('test', 'POST');
      assert.deepEqual(f.requests.map(({ url }) => url), [
        'http://new-memory.invalid/v1/default/banks',
        'http://new-memory.invalid/v1/default/banks/shared/documents?limit=1',
      ]);
    });
  }
});

test('saving other settings or the current daemon URL keeps daemon mode', async (t) => {
  const f = await fixture(t, { serverMode: 'daemon', apiPort: 12345 });
  for (const patch of [
    { retainSessions: false },
    { apiUrl: 'http://127.0.0.1:12345' },
    { apiUrl: ' http://127.0.0.1:12345/ ' },
  ]) {
    const { body } = await f.request('save', 'POST', patch);
    assert.equal(body.settings.serverMode, 'daemon');
    assert.equal(body.settings.apiUrl, 'http://127.0.0.1:12345');
    assert.equal(JSON.parse(readFileSync(f.configPath, 'utf8')).harnesses.dsh.serverMode, undefined);
  }
});

test('connection failures remain visible to the settings panel', async (t) => {
  const f = await fixture(t, { apiUrl: 'http://memory.invalid', mapPathToBank: { '/tmp': 'shared' } });
  globalThis.fetch = async () => new Response('service unavailable', { status: 503 });
  assert.deepEqual((await f.request('banks')).body, { ok: false, error: 'HTTP 503', banks: [] });
  const probe = (await f.request('test', 'POST')).body;
  assert.equal(probe.ok, false);
  assert.equal(probe.status, 503);
});
