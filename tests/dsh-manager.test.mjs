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

async function fixture(t, initial, pluginConfig = {}) {
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
  let plugin = await ctx.plugin(manager, { ...pluginConfig, configPath });
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return Response.json(String(url).includes('/documents') ? { items: [] }
      : { banks: [{ bank_id: 'shared' }], total: 1, limit: 100, offset: 0 });
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
      plugin = await ctx.plugin(manager, { ...pluginConfig, configPath });
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

function installation(t) {
  const packagePath = mkdtempSync(join(tmpdir(), 'dsh-manager-package-'));
  t.after(() => rmSync(packagePath, { recursive: true, force: true }));
  writeFileSync(join(packagePath, 'package.json'), JSON.stringify(managerConfig.supportedEnhancement.upstream));
  writeFileSync(join(packagePath, managerConfig.declarationFile), JSON.stringify({
    ...managerConfig.supportedEnhancement, capabilities: { autoInjectEveryTurns: true },
  }));
  writeFileSync(join(packagePath, managerConfig.supportedEnhancement.defaultsFile), JSON.stringify({
    autoInject: 'recall', autoInjectEveryTurns: 1, injectTimeoutMs: 7000,
    recallOptions: { types: ['observation', 'world', 'experience'], budget: 'low', max_tokens: 2000 },
  }));
  return packagePath;
}

test('an associated declaration supplies policy defaults and permits frequency editing without importing its runtime', async (t) => {
  const officialPackagePath = installation(t);
  const f = await fixture(t, { autoReflect: false }, { officialPackagePath });
  const current = (await f.request('state')).body;
  assert.equal(current.enhancement.status, 'declared');
  assert.equal(current.enhancement.autoInjectEveryTurns, true);
  assert.equal(current.autoInject, 'recall');
  assert.deepEqual(current.sources.autoInject, { layer: 'policy', key: 'autoInject' });
  assert.equal(current.autoInjectEveryTurns, 1);
  assert.deepEqual(current.recallOptions.types, ['observation', 'world', 'experience']);
  const saved = await f.request('save', 'POST', { set: { autoInjectEveryTurns: 0, injectTimeoutMs: 9000 } });
  assert.equal(saved.body.settings.autoInjectEveryTurns, 0);
  assert.equal(saved.body.settings.injectTimeoutMs, 9000);
  const restored = await f.request('save', 'POST', { inherit: ['autoInjectEveryTurns'] });
  assert.equal(restored.body.settings.autoInjectEveryTurns, 1);
  assert.equal(f.requests.length, 0);
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
  const { status, body } = await f.request('save', 'POST', { set: {
    apiUrl: 'http://after.invalid', positions: [{ dir: f.directory, bank: 'updated' }],
    optInOnly: true, retainSessions: false,
  } });
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
  await f.request('save', 'POST', { set: { positions: [] } });
  assert.deepEqual((await f.request('state')).body.positions, []);
});

test('a new installation reads explicit form defaults and writes config only on save', async (t) => {
  const f = await fixture(t);
  const { body } = await f.request('state');
  assert.equal(body.exists, false);
  assert.equal(body.apiUrl, managerConfig.formDefaults.apiUrl);
  assert.equal(body.optInOnly, managerConfig.formDefaults.optInOnly);
  assert.equal(existsSync(f.configPath), false);
  const saved = await f.request('save', 'POST', { set: {
    apiUrl: 'http://memory.invalid', positions: [{ dir: f.directory, bank: 'new' }],
    optInOnly: true, retainSessions: true,
  } });
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
  assert.deepEqual((await f.request('banks')).body, { ok: true, banks: ['shared'], total: 1, limit: 100, offset: 0 });
  const probe = (await f.request('test', 'POST')).body;
  assert.equal(probe.ok, true);
  assert.equal(probe.bank, 'team/shared');
  assert.deepEqual(f.requests.map(({ url }) => url), [
    'http://dsh.invalid/v1/default/banks?limit=100&offset=0',
    'http://dsh.invalid/v1/default/banks/team%2Fshared/documents?limit=1',
  ]);
  for (const { options } of f.requests) {
    assert.equal(options.headers.Authorization, 'Bearer dsh-token');
  }
  writeFileSync(f.configPath, JSON.stringify({
    apiUrl: 'http://updated.invalid', apiToken: 'updated-token',
  }));
  await f.request('banks');
  assert.equal(f.requests.at(-1).url, 'http://updated.invalid/v1/default/banks?limit=100&offset=0');
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
  assert.equal(f.requests[0].url, 'http://127.0.0.1:12345/v1/default/banks?limit=100&offset=0');
});

test('changing the daemon URL selects self-hosted mode and uses the new service after reload', async (t) => {
  for (const initial of [
    { serverMode: 'daemon', apiPort: 12345 },
    { serverMode: 'cloud', harnesses: { dsh: { serverMode: 'daemon', apiPort: 12345 } } },
  ]) {
    await t.test(initial.harnesses ? 'DSH mode' : 'inherited mode', async (t) => {
      const f = await fixture(t, { ...initial, mapPathToBank: { '/tmp': 'shared' } });
      const { body } = await f.request('save', 'POST', { set: { apiUrl: '  http://new-memory.invalid/  ' } });
      assert.equal(body.ok, true);
      assert.equal(body.settings.serverMode, 'self-hosted');
      assert.equal(body.settings.apiUrl, 'http://new-memory.invalid/');
      assert.equal(JSON.parse(readFileSync(f.configPath, 'utf8')).harnesses.dsh.serverMode, 'self-hosted');
      await f.reload();
      assert.equal((await f.request('state')).body.apiUrl, 'http://new-memory.invalid/');
      await f.request('banks');
      await f.request('test', 'POST');
      assert.deepEqual(f.requests.map(({ url }) => url), [
        'http://new-memory.invalid/v1/default/banks?limit=100&offset=0',
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
    const { body } = await f.request('save', 'POST', { set: patch });
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

test('incremental saves leave inherited values live and explicit inheritance deletes overrides', async (t) => {
  const f = await fixture(t, { apiUrl: 'http://before.invalid', retainSessions: true });
  const saved = await f.request('save', 'POST', { set: { apiUrl: 'http://after.invalid' }, inherit: [] });
  assert.equal(saved.body.settings.apiUrl, 'http://after.invalid');
  assert.equal(saved.body.settings.overrides.retainSessions, false);
  let raw = JSON.parse(readFileSync(f.configPath, 'utf8'));
  assert.deepEqual(raw.harnesses.dsh, { apiUrl: 'http://after.invalid' });
  raw.retainSessions = false;
  writeFileSync(f.configPath, JSON.stringify(raw));
  assert.equal((await f.request('state')).body.retainSessions, false);
  await f.request('save', 'POST', { set: { retainSessions: true } });
  const restored = await f.request('save', 'POST', { inherit: ['retainSessions'] });
  assert.equal(restored.body.settings.retainSessions, false);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(f.configPath, 'utf8')).harnesses.dsh, 'retainSessions'), false);
});

test('recall options replace between layers and edits preserve the winning raw group', async (t) => {
  const f = await fixture(t, {
    recallOptions: { types: ['world'], budget: 'high', tags: ['global'] },
    harnesses: { dsh: { recallOptions: { max_tokens: 1000, tags: ['local'], include: { chunks: true } } } },
  });
  const current = (await f.request('state')).body;
  assert.deepEqual(current.recallOptions, { types: ['observation'], budget: 'low', max_tokens: 1000 });
  assert.deepEqual(current.inherited.recallOptions, { types: ['world'], budget: 'high', max_tokens: 2000 });
  assert.deepEqual(current.configured.recallOptions, { max_tokens: 1000 });
  assert.equal(JSON.stringify(current).includes('chunks'), false);
  const edited = await f.request('save', 'POST', { set: { recallOptions: { max_tokens: 3000, types: null } } });
  assert.equal(edited.body.settings.recallOptions.types, null);
  assert.deepEqual(JSON.parse(readFileSync(f.configPath, 'utf8')).harnesses.dsh.recallOptions, {
    max_tokens: 3000, types: null, tags: ['local'], include: { chunks: true },
  });
  await f.request('save', 'POST', { inherit: ['recallOptions'] });
  assert.deepEqual((await f.request('state')).body.recallOptions, current.inherited.recallOptions);
  await f.request('save', 'POST', { set: { recallOptions: { types: [], max_tokens: 4000 } } });
  assert.deepEqual(JSON.parse(readFileSync(f.configPath, 'utf8')).harnesses.dsh.recallOptions, {
    types: [], budget: 'high', tags: ['global'], max_tokens: 4000,
  });
});

test('legacy autoReflect is resolved after raw merging and restoring the mode removes its old alias', async (t) => {
  const f = await fixture(t, { autoReflect: false, harnesses: { dsh: { autoReflect: true } } });
  const current = (await f.request('state')).body;
  assert.equal(current.autoInject, 'reflect');
  assert.equal(current.overrides.autoInject, true);
  assert.deepEqual(current.sources.autoInject, { layer: 'dsh', key: 'autoReflect' });
  assert.equal(current.inherited.autoInject, 'none');
  const restored = (await f.request('save', 'POST', { inherit: ['autoInject'] })).body.settings;
  assert.equal(restored.autoInject, 'none');
  assert.equal(restored.overrides.autoInject, false);
  assert.deepEqual(JSON.parse(readFileSync(f.configPath, 'utf8')).harnesses.dsh, {});
  await f.request('save', 'POST', { set: { autoInject: 'pages' } });
  assert.equal((await f.request('state')).body.autoInject, 'pages');
});

test('invalid edits report their field or row and never partially write the configuration', async (t) => {
  const f = await fixture(t, { retainSessions: true, harnesses: { dsh: { customSetting: 'keep' } } });
  const before = readFileSync(f.configPath, 'utf8');
  const invalid = [
    [{ apiUrl: 'http://legacy.invalid' }, /apiUrl/],
    [{ set: null }, /set/],
    [{ inherit: null }, /inherit/],
    [{ set: { apiToken: 'not-editable' } }, /apiToken/],
    [{ set: { retainSessions: 'false' } }, /retainSessions/],
    [{ set: { injectTimeoutMs: 0 } }, /injectTimeoutMs/],
    [{ set: { autoInjectEveryTurns: 1 } }, /增强/],
    [{ set: { autoInject: 'unknown' } }, /autoInject/],
    [{ set: { recallOptions: { budget: 'unlimited' } } }, /budget/],
    [{ set: { recallOptions: { types: [false] } } }, /types/],
    [{ set: { recallOptions: { max_tokens: 2.5 } } }, /max_tokens/],
    [{ set: { recallOptions: { tags: ['not-a-control'] } } }, /tags/],
    [{ set: { positions: [{ dir: '/tmp', bank: '' }] } }, /1.*bank/],
    [{ set: { positions: [{ dir: '', bank: 'shared' }] } }, /1.*dir/],
    [{ set: { positions: [{ dir: '/tmp/', bank: 'a' }, { dir: '/tmp', bank: 'b' }] } }, /2.*1/],
    [{ set: { retainSessions: false }, inherit: ['retainSessions'] }, /retainSessions/],
    [{ set: { apiUrl: 'http://changed.invalid' }, inherit: ['connection'] }, /connection/],
    [{ inherit: ['recallOptions.types'] }, /recallOptions.types/],
  ];
  for (const [patch, message] of invalid) {
    const result = await f.request('save', 'POST', patch);
    assert.equal(result.status, 400, JSON.stringify(patch));
    assert.match(result.body.error, message);
    assert.equal(readFileSync(f.configPath, 'utf8'), before);
  }
});

test('bank listing uses the deployed API page contract and distinguishes an empty page from a malformed response', async (t) => {
  const f = await fixture(t, { apiUrl: 'http://memory.invalid' });
  globalThis.fetch = async (url) => {
    assert.equal(String(url), `http://memory.invalid/v1/default/banks?limit=${managerConfig.bankListLimit}&offset=0`);
    return Response.json({ banks: [{ bank_id: 'one', name: 'One' }], total: 150, limit: 100, offset: 0 });
  };
  assert.deepEqual((await f.request('banks')).body, { ok: true, banks: ['one'], total: 150, limit: 100, offset: 0 });
  globalThis.fetch = async () => Response.json({ banks: [], total: 0, limit: 100, offset: 0 });
  assert.deepEqual((await f.request('banks')).body, { ok: true, banks: [], total: 0, limit: 100, offset: 0 });
  for (const response of [{}, { items: [] }, { banks: [] }, { banks: [{ id: 'old' }], total: 1, limit: 100, offset: 0 }]) {
    globalThis.fetch = async () => Response.json(response);
    const listed = (await f.request('banks')).body;
    assert.equal(listed.ok, false);
    assert.match(listed.error, /banks.*bank_id.*total.*limit.*offset/);
  }
});

test('mapping edits normalize surrounding whitespace while retaining spaces inside directory names', async (t) => {
  const f = await fixture(t);
  const result = await f.request('save', 'POST', { set: {
    positions: [{ dir: '  /tmp/work space///  ', bank: '  project  ' }],
  } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.settings.positions, [{ dir: '/tmp/work space', bank: 'project', exists: false }]);
  assert.deepEqual(JSON.parse(readFileSync(f.configPath, 'utf8')).harnesses.dsh.mapPathToBank, { '/tmp/work space': 'project' });
});

test('empty saves and inheritance without overrides do not create a configuration file', async (t) => {
  const f = await fixture(t);
  for (const patch of [{}, { set: {}, inherit: [] }, { set: { recallOptions: {} } }, { inherit: ['connection', 'autoInject'] }]) {
    const saved = await f.request('save', 'POST', patch);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.settings.exists, false);
    assert.equal(existsSync(f.configPath), false);
  }
});

test('restoring connection inheritance removes all three connection fields and keeps credentials', async (t) => {
  const f = await fixture(t, {
    serverMode: 'daemon', apiPort: 12345,
    harnesses: { dsh: { serverMode: 'daemon', apiPort: 23456, apiUrl: 'http://unused.invalid', apiToken: 'test-token' } },
  });
  let current = (await f.request('state')).body;
  assert.equal(current.apiUrl, 'http://127.0.0.1:23456');
  assert.equal(current.inherited.apiUrl, 'http://127.0.0.1:12345');
  await f.request('save', 'POST', { set: { apiUrl: 'http://replacement.invalid' } });
  current = (await f.request('save', 'POST', { inherit: ['connection'] })).body.settings;
  assert.equal(current.apiUrl, 'http://127.0.0.1:12345');
  assert.equal(current.apiTokenConfigured, true);
  assert.deepEqual(JSON.parse(readFileSync(f.configPath, 'utf8')).harnesses.dsh, { apiToken: 'test-token' });
  for (const key of ['apiUrl', 'apiPort', 'serverMode']) assert.equal(current.overrides[key], false);
});

test('missing or mismatched declarations keep ordinary settings available while exposing association problems', async (t) => {
  const officialPackagePath = installation(t);
  const declarationPath = join(officialPackagePath, managerConfig.declarationFile);
  const declaration = readFileSync(declarationPath, 'utf8');
  const f = await fixture(t, { harnesses: { dsh: { autoInjectEveryTurns: 4 } } }, { officialPackagePath });
  rmSync(declarationPath);
  let current = (await f.request('state')).body;
  assert.equal(current.enhancement.status, 'undeclared');
  assert.equal(current.autoInjectEveryTurns, 4);
  assert.equal(current.autoInject, 'reflect');
  assert.equal((await f.request('save', 'POST', { set: { autoInjectEveryTurns: 1 } })).status, 400);
  assert.equal((await f.request('save', 'POST', { inherit: ['autoInjectEveryTurns'] })).status, 200);
  writeFileSync(declarationPath, declaration);
  writeFileSync(join(officialPackagePath, 'package.json'), JSON.stringify({ ...managerConfig.supportedEnhancement.upstream, version: '0.8.8' }));
  current = (await f.request('state')).body;
  assert.equal(current.enhancement.status, 'error');
  assert.match(current.enhancement.error, /不一致/);
  const saved = await f.request('save', 'POST', { set: { autoInject: 'none', retainSessions: false } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.autoInject, 'none');
  assert.equal(saved.body.settings.retainSessions, false);
  assert.equal(saved.body.settings.enhancement.status, 'error');
});

test('unrecognized existing control values remain visible and survive editing unrelated settings', async (t) => {
  const initial = {
    harnesses: { dsh: {
      autoInject: 'future-mode', autoReflect: false, autoInjectEveryTurns: 'custom-frequency',
      recallOptions: { types: ['future-type'], budget: 'future-budget', max_tokens: 'custom-budget', tags: ['hidden'] },
    } },
  };
  const f = await fixture(t, initial);
  const current = (await f.request('state')).body;
  assert.equal(current.autoInject, 'none');
  assert.equal(current.configured.autoInject, 'future-mode');
  assert.equal(current.autoInjectEveryTurns, 'custom-frequency');
  assert.equal(current.recallOptions.budget, 'future-budget');
  assert.equal(current.recallOptions.max_tokens, 'custom-budget');
  assert.deepEqual(current.recallOptions.types, ['future-type']);
  assert.equal(current.configured.recallOptions.tags, undefined);
  await f.request('save', 'POST', { set: { retainSessions: false } });
  assert.deepEqual(JSON.parse(readFileSync(f.configPath, 'utf8')).harnesses.dsh, {
    ...initial.harnesses.dsh, retainSessions: false,
  });
});

test('equivalent normalized mapping edits preserve inheritance and an existing override', async (t) => {
  for (const localOverride of [false, true]) {
    await t.test(localOverride ? 'existing override' : 'inherited mappings', async (t) => {
      const mapPathToBank = { '/tmp': 'first', '/tmp/work space': 'second' };
      const initial = { mapPathToBank, ...(localOverride ? { harnesses: { dsh: { mapPathToBank } } } : {}) };
      const f = await fixture(t, initial);
      const before = readFileSync(f.configPath, 'utf8');
      const result = await f.request('save', 'POST', { set: { positions: [
        { dir: ' /tmp/work space/// ', bank: ' second ' },
        { dir: ' /tmp/ ', bank: ' first ' },
      ] } });
      assert.equal(result.status, 200);
      assert.equal(result.body.settings.overrides.positions, localOverride);
      assert.equal(readFileSync(f.configPath, 'utf8'), before);
      if (!localOverride) {
        writeFileSync(f.configPath, JSON.stringify({ mapPathToBank: { '/tmp': 'updated-global' } }));
        assert.equal((await f.request('state')).body.positions[0].bank, 'updated-global');
      }
    });
  }
  await t.test('an unchanged empty map creates no configuration', async (t) => {
    const f = await fixture(t);
    const result = await f.request('save', 'POST', { set: { positions: [] } });
    assert.equal(result.status, 200);
    assert.equal(existsSync(f.configPath), false);
  });
});
