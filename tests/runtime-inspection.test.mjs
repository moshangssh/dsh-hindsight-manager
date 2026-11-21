import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostModule } from './host-modules.mjs';
import * as manager from '../index.js';
import managerConfig from '../manager.config.json' with { type: 'json' };

const { Context } = await hostModule('@deepseek-ai/cordis');
const runtimeDescription = {
  upstreamVersion: managerConfig.supportedEnhancement.upstream.version,
  patchSetVersion: managerConfig.supportedEnhancement.patchSetVersion,
  capabilities: {
    autoInjectEveryTurns: true, runtimeInspection: true, recallSummary: true, injectionCorrelation: true,
  },
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hindsight-runtime-inspection-'));
  const configPath = join(directory, 'coding-agent.json');
  // Runtime queries must not read or resolve the on-disk settings.
  await writeFile(configPath, 'not valid configuration JSON');
  const ctx = new Context();
  const routes = new Map();
  const plugins = [];
  ctx.provide('connection', { requestRejection() {} });
  ctx.provide('webServer', { register({ path, handler }) {
    assert.equal(routes.has(path), false);
    routes.set(path, handler);
    return () => routes.delete(path);
  } });
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Runtime inspection must not issue HTTP requests'); };
  t.after(async () => {
    for (const plugin of plugins.reverse()) await plugin.dispose();
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true });
  });
  const plugin = await ctx.plugin(manager, { configPath });
  plugins.push(plugin);
  return {
    ctx, routes,
    requests: () => requests,
    async provide(name, value) {
      const provider = await ctx.plugin({ name: `inspection-test-${name}`, apply(owner) { owner.provide(name, value); } });
      plugins.push(provider);
      return provider;
    },
    async request(sessionId, method = 'GET') {
      const query = sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(sessionId)}`;
      let status;
      let body;
      await routes.get('/plugins/dsh-hindsight-manager/runtime')({
        method, url: `/plugins/dsh-hindsight-manager/runtime${query}`,
      }, {
        writeHead(value) { status = value; },
        end(value) { body = JSON.parse(value); },
      });
      return { status, body };
    },
  };
}

function provider(inspections) {
  return {
    inspect(agent) {
      inspections.push(agent);
      return {
        protocolVersion: 1, status: agent ? 'workspace_uninitialized' : 'session_not_active',
        hooksDisabled: false, runtime: runtimeDescription, effective: null,
      };
    },
    queryScope() { return undefined; },
  };
}

test('runtime status follows real Cordis service loading, unloading and replacement without touching configuration', async (t) => {
  const f = await fixture(t);
  const absent = await f.request('cold-session');
  assert.equal(absent.status, 200);
  assert.deepEqual(absent.body, {
    protocolVersion: 1, sessionId: 'cold-session', status: 'runtime_unavailable',
    hooksDisabled: null, runtime: null, effective: null,
  });

  const inspected = [];
  const first = await f.provide('hindsightRuntime', provider(inspected));
  const noAgents = (await f.request('cold-session')).body;
  assert.equal(noAgents.status, 'agent_service_unavailable');
  assert.deepEqual(noAgents.runtime, runtimeDescription);
  assert.equal(noAgents.effective, null);
  assert.deepEqual(inspected, [undefined]);

  const agent = { session: { id: 'active-session' } };
  const reads = [];
  const agents = await f.provide('agents', {
    get(id) { reads.push(id); return id === 'active-session' ? agent : undefined; },
    create() { assert.fail('inspection must not create an agent'); },
    resume() { assert.fail('inspection must not resume a historical session'); },
  });
  assert.equal((await f.request('active-session')).body.status, 'workspace_uninitialized');
  const cold = (await f.request('cold-session')).body;
  assert.equal(cold.status, 'session_not_active');
  assert.deepEqual(cold.runtime, runtimeDescription);
  assert.equal(cold.effective, null);
  assert.deepEqual(inspected, [undefined, agent, undefined]);
  assert.deepEqual(reads, ['active-session', 'cold-session']);

  await first.dispose();
  assert.equal((await f.request('active-session')).body.status, 'runtime_unavailable');
  assert.deepEqual(reads, ['active-session', 'cold-session'], 'absent provider does not query the registry');
  const replacementReads = [];
  await f.provide('hindsightRuntime', provider(replacementReads));
  assert.equal((await f.request('active-session')).body.status, 'workspace_uninitialized');
  assert.deepEqual(replacementReads, [agent]);
  assert.deepEqual(inspected, [undefined, agent, undefined], 'unloaded provider is never used again');

  await agents.dispose();
  assert.equal((await f.request('active-session')).body.status, 'agent_service_unavailable');
  assert.deepEqual(replacementReads, [agent, undefined]);
  assert.equal(f.requests(), 0);
  assert.equal(f.routes.size, 5, 'optional services do not re-register settings routes');
});

test('concurrent runtime queries use the requested active agent and preserve provider facts', async (t) => {
  const f = await fixture(t);
  const sessions = new Map([
    ['project a', { session: { id: 'project a' } }],
    ['project/b', { session: { id: 'project/b' } }],
  ]);
  const facts = new Map([
    [sessions.get('project a'), {
      protocolVersion: 1, status: 'ready', hooksDisabled: true, runtime: runtimeDescription,
      effective: {
        workspaceRoot: '/project-a', bankId: 'bank-a', apiUrl: 'http://memory-a.internal',
        autoInject: 'reflect', autoInjectEveryTurns: 3, retainSessions: true,
        injectTimeoutMs: 7000, recallOptions: { budget: 'low', max_tokens: 2000, types: ['observation'] },
      },
    }],
    [sessions.get('project/b'), {
      protocolVersion: 1, status: 'disabled', hooksDisabled: false,
      runtime: runtimeDescription, effective: null,
    }],
  ]);
  await f.provide('agents', { get: (id) => sessions.get(id) });
  await f.provide('hindsightRuntime', {
    inspect: (agent) => facts.get(agent), queryScope: () => undefined,
  });
  const results = await Promise.all([...sessions.keys()].map((id) => f.request(id)));
  for (const [index, [id, agent]] of [...sessions.entries()].entries()) {
    assert.equal(results[index].status, 200);
    assert.deepEqual(results[index].body, { ...facts.get(agent), sessionId: id });
  }
  assert.equal(f.requests(), 0);
});

test('runtime inspection requires an explicit session and keeps the route read-only', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.request(undefined), { status: 400, body: { error: 'sessionId is required' } });
  assert.deepEqual(await f.request(''), { status: 400, body: { error: 'sessionId is required' } });
  assert.deepEqual(await f.request('active-session', 'POST'), { status: 405, body: { error: 'method not allowed' } });
  assert.equal(f.requests(), 0);
});
