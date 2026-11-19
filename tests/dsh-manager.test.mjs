import assert from 'node:assert/strict';
import { after, beforeEach, afterEach, test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

const directory = mkdtempSync(join(tmpdir(), 'dsh-manager-test-'));
const configPath = join(directory, 'coding-agent.json');
const workspace = join(directory, 'workspace-does-not-need-to-exist');
const unmapped = join(directory, 'unmapped');
const previousEnvironment = new Map();
for (const [key, value] of Object.entries({
  HINDSIGHT_CONFIG: configPath,
  HINDSIGHT_DIAG_FILE: join(directory, 'diagnostics.jsonl'),
  HINDSIGHT_LOG_FILE: join(directory, 'plugin.log'),
})) {
  previousEnvironment.set(key, process.env[key]);
  process.env[key] = value;
}
const { apply } = await import('../index.js');

const dshExecutable = process.env.PATH.split(delimiter).map((path) => join(path, 'dsh')).find(existsSync);
assert.ok(dshExecutable, 'DSH must be installed to verify the actual host registry contract');
const hostModules = join(dirname(dirname(realpathSync(dshExecutable))), 'node_modules');
const { Context } = await import(pathToFileURL(join(hostModules, '@deepseek-ai/cordis/lib/index.js')));
const { ToolsService } = await import(pathToFileURL(join(hostModules, '@deepseek-ai/dsh-tools/lib/index.js')));
const originalFetch = globalThis.fetch;
let requests = [];
let respond;
globalThis.fetch = async (url, options) => {
  requests.push({ url: String(url), options });
  return respond(url, options);
};

function writeSettings(positions = { [workspace]: 'bank-before' }, apiUrl = 'http://before.invalid') {
  writeFileSync(configPath, JSON.stringify({
    serverMode: 'self-hosted',
    apiUrl,
    autoUpdate: false,
    autoSeed: false,
    harnesses: { dsh: { optInOnly: true, mapPathToBank: positions, retainSessions: false } },
  }));
}

function makeAgent(cwd, id = 'existing-session', origin = 'user') {
  return { session: { header: { id, cwd, origin } } };
}

function makeHost() {
  const registryContext = new Context();
  registryContext.provide('systemPrompt', { tools() {} });
  const tools = new ToolsService(registryContext);
  const routes = new Map();
  const events = new Map();
  const disposers = [];
  const ctx = {
    tools,
    logger: { info() {}, warn() {}, debug() {} },
    effect(start) {
      const dispose = start();
      disposers.push(dispose);
      return dispose;
    },
    on(name, callback) { events.set(name, callback); },
    inject(dependencies, callback) {
      if (dependencies[0] === 'tools') callback(ctx);
      if (dependencies[0] === 'webServer') callback({
        effect: ctx.effect,
        webServer: { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path); } },
      });
      if (dependencies[0] === 'connection') callback({ connection: { requestRejection() {} } });
    },
  };
  apply(ctx);
  return {
    tools, events,
    async save(patch) {
      const req = Readable.from([Buffer.from(JSON.stringify(patch))]);
      req.method = 'POST';
      req.headers = {};
      let status;
      let payload;
      await routes.get('/plugins/dsh-hindsight-manager/save')(req, {
        writeHead(value) { status = value; },
        end(value) { payload = JSON.parse(value); },
      });
      assert.equal(status, 200, JSON.stringify(payload));
      assert.equal(payload.ok, true);
      return payload;
    },
    async names(agent) {
      const selected = await tools.resolve({ agent, signal: new AbortController().signal });
      try { return tools.schemas(agent, selected).map(({ name }) => name); }
      finally { selected.dispose(); }
    },
    async call(name, agent, signal = new AbortController().signal) {
      const selected = await tools.resolve({ agent, signal });
      try {
        const definition = tools.executable(name, agent, selected);
        assert.ok(definition, `${name} should be admitted`);
        return await definition.execute({}, { agent, signal });
      } finally { selected.dispose(); }
    },
    async dispose() {
      for (const dispose of disposers.reverse()) await dispose();
    },
  };
}

let host;
beforeEach(() => {
  writeSettings();
  requests = [];
  respond = async () => Response.json({ roots: [] });
});
afterEach(async () => { await host?.dispose(); host = undefined; });
after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

test('actual DSH registry admits mapped workspaces only and uses agent/created', async () => {
  const cwd = process.cwd();
  host = makeHost();
  const mapped = await host.names(makeAgent(workspace));
  assert.ok(mapped.includes('hindsight_list_pages'));
  assert.deepEqual(await host.names(makeAgent(unmapped)), []);
  assert.deepEqual(await host.names(makeAgent(workspace, 'child', 'subagent')), []);
  assert.ok(host.events.has('agent/created'));
  assert.equal(host.events.has('agent/session-start'), false);
  assert.equal(process.cwd(), cwd);
  assert.equal(requests.length, 0);
});

test('saving changes bank and API URL for the same directory and new sessions', async () => {
  host = makeHost();
  const existing = makeAgent(workspace);
  await host.call('hindsight_list_pages', existing);
  assert.match(requests.at(-1).url, /^http:\/\/before\.invalid\/v1\/default\/banks\/bank-before\//);
  await host.save({ positions: [{ dir: workspace, bank: 'bank-after' }], apiUrl: 'http://after.invalid' });
  for (const agent of [existing, makeAgent(workspace, 'new-session')]) {
    await host.call('hindsight_list_pages', agent);
    assert.match(requests.at(-1).url, /^http:\/\/after\.invalid\/v1\/default\/banks\/bank-after\//);
    const diagnostics = JSON.parse(await host.call('hindsight_diagnose', agent));
    assert.equal(diagnostics.bank_id, 'bank-after');
    assert.equal(diagnostics.config.api_url, 'http://after.invalid');
  }
  assert.equal(JSON.parse(readFileSync(configPath)).harnesses.dsh.mapPathToBank[workspace], 'bank-after');
});

test('first mapping appears without restart and removal revokes existing sessions', async () => {
  writeSettings({});
  host = makeHost();
  const agent = makeAgent(workspace);
  assert.deepEqual(await host.names(agent), []);
  await host.save({ positions: [{ dir: workspace, bank: 'first-bank' }] });
  assert.ok((await host.names(agent)).includes('hindsight_list_pages'));
  await host.call('hindsight_list_pages', agent);
  assert.match(requests.at(-1).url, /\/banks\/first-bank\//);
  await host.save({ positions: [] });
  assert.deepEqual(await host.names(agent), []);
  assert.deepEqual(host.tools.schemas(), []);
});

test('tool failures reject instead of returning a successful error string', async () => {
  host = makeHost();
  respond = async () => new Response('memory server unavailable', { status: 503 });
  await assert.rejects(host.call('hindsight_list_pages', makeAgent(workspace)), /503|memory server unavailable/);
});

test('tool cancellation reaches the HTTP request', async () => {
  host = makeHost();
  const controller = new AbortController();
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  respond = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    requestStarted(signal);
  });
  const pending = host.call('hindsight_list_pages', makeAgent(workspace), controller.signal);
  const requestSignal = await started;
  controller.abort(new Error('test cancellation'));
  await assert.rejects(pending, /test cancellation|aborted/i);
  assert.equal(requestSignal.aborted, true);
});

test('unloading releases registered tools and reloading does not duplicate them', async () => {
  host = makeHost();
  const count = host.tools.schemas().length;
  assert.ok(count > 0);
  await host.dispose();
  assert.deepEqual(host.tools.schemas(), []);
  host = makeHost();
  assert.equal(host.tools.schemas().length, count);
});

test('real Cordis plugin lifecycle supports save, unload and reload', async () => {
  const ctx = new Context();
  ctx.provide('systemPrompt', { tools() {} });
  ctx.provide('agents', {});
  ctx.provide('connection', { requestRejection() {} });
  const routes = new Map();
  ctx.provide('webServer', {
    register({ path, handler }) {
      routes.set(path, handler);
      return () => routes.delete(path);
    },
  });
  const tools = new ToolsService(ctx);
  const manager = await import('../index.js');
  let plugin = await ctx.plugin(manager);
  try {
    const count = tools.schemas().length;
    assert.ok(count > 0);
    const req = Readable.from([Buffer.from(JSON.stringify({ positions: [{ dir: workspace, bank: 'saved-bank' }] }))]);
    req.method = 'POST';
    req.headers = {};
    let status;
    await routes.get('/plugins/dsh-hindsight-manager/save')(req, {
      writeHead(value) { status = value; },
      end(value) { assert.equal(JSON.parse(value).ok, true, value); },
    });
    assert.equal(status, 200);
    const agent = makeAgent(workspace);
    const signal = new AbortController().signal;
    const admitted = await tools.resolve({ agent, signal });
    try {
      assert.equal(tools.schemas(agent, admitted).length, count);
      const result = await tools.executable('hindsight_diagnose', agent, admitted).execute({}, { agent, signal });
      assert.equal(JSON.parse(result).bank_id, 'saved-bank');
    } finally { admitted.dispose(); }
    await plugin.dispose();
    assert.deepEqual(tools.schemas(), []);
    assert.equal(routes.size, 0);
    plugin = await ctx.plugin(manager);
    assert.equal(tools.schemas().length, count);
    assert.equal(routes.size, 4);
  } finally {
    await plugin.dispose();
  }
});
