import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as manager from '../../index.js';
import { RECALL_EVENT } from '../../activity.js';
import { hostModule, hostUrl } from '../host-modules.mjs';

// Uses the real DSH loop, session surface and adapter lifecycle. Only the external
// memory transport and the model stream are replaced, so no server is required.
export async function registerObservationTests(officialPackagePath) {
  await test('running Hindsight observations reach the real DSH session and manager', { timeout: 20_000 }, async (suite) => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-observations-'));
    const configPath = join(directory, 'coding-agent.json');
    const previousEnvironment = new Map(Object.keys(process.env)
      .filter((key) => key.startsWith('HINDSIGHT_')).map((key) => [key, process.env[key]]));
    for (const key of previousEnvironment.keys()) delete process.env[key];
    Object.assign(process.env, {
      HINDSIGHT_CONFIG: configPath,
      HINDSIGHT_LOG_FILE: join(directory, 'plugin.log'),
      HINDSIGHT_DIAG_FILE: join(directory, 'diagnostics.jsonl'),
      HINDSIGHT_USAGE_FILE: join(directory, 'usage.jsonl'),
    });
    const originalFetch = globalThis.fetch;
    const sessionUrl = hostUrl('@deepseek-ai/dsh-session');
    const resolver = registerHooks({ resolve(name, context, next) {
      return name === '@deepseek-ai/dsh-session' ? { url: sessionUrl, shortCircuit: true } : next(name, context);
    } });
    suite.after(() => {
      resolver.deregister();
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env).filter((name) => name.startsWith('HINDSIGHT_'))) delete process.env[key];
      for (const [key, value] of previousEnvironment) process.env[key] = value;
      rmSync(directory, { recursive: true, force: true });
    });
    // settings.test.mjs imports the same bundle with a different CONFIG_PATH.
    const adapter = await import(`${pathToFileURL(join(officialPackagePath, 'dist/dsh.js'))}?observations`);
    const { Context } = await hostModule('@deepseek-ai/cordis');
    const { Session, deriveEventMessage } = await hostModule('@deepseek-ai/dsh-session');
    const { default: AgentLoop } = await hostModule('@deepseek-ai/dsh-agent-loop');
    const hostPlugins = await Promise.all([
      'dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-system-prompt', 'dsh-tools', 'dsh-tool-executor-native',
    ].map((name) => hostModule(`@deepseek-ai/${name}`)));
    const manifest = JSON.parse(readFileSync(join(officialPackagePath, 'package.json'), 'utf8'));

    async function fixture(t, { loadRuntime = true } = {}) {
      const root = join(directory, randomUUID());
      const secondRoot = join(directory, randomUUID());
      mkdirSync(root);
      mkdirSync(secondRoot);
      writeFileSync(configPath, JSON.stringify({
        serverMode: 'self-hosted', apiUrl: 'http://memory.observations.invalid', bankId: 'observations',
        autoSeed: false, autoUpdate: false, retainSessions: false,
        autoInject: 'recall', autoInjectEveryTurns: 1,
      }));
      const ctx = new Context();
      const plugins = [];
      const agents = [];
      const routes = new Map();
      const requests = [];
      const modelCalls = [];
      const errors = [];
      const unexpectedRequests = [];
      const responses = {
        recall: ({ body }) => Response.json({ results: [{ text: `Memory about ${body.query}` }] }),
        pagesTree: () => Response.json({ roots: [] }),
      };
      globalThis.fetch = async (input, options = {}) => {
        const url = new URL(input);
        assert.equal(url.origin, 'http://memory.observations.invalid');
        const request = { url, path: url.pathname, body: options.body ? JSON.parse(options.body) : undefined, signal: options.signal };
        requests.push(request);
        if (request.path.endsWith('/memories/recall')) return responses.recall(request);
        if (request.path.endsWith('/pages/tree')) return responses.pagesTree(request);
        unexpectedRequests.push(request.path);
        throw new Error(`Unexpected memory request: ${request.path}`);
      };
      t.after(async () => {
        for (const agent of agents) {
          agent.cancel({ kind: 'disposed' });
          await agent.whenIdle();
        }
        for (const plugin of plugins.reverse()) await plugin.dispose();
        for (const agent of agents) rmSync(join(tmpdir(), 'hindsight-dsh', `${agent.session.header.id}.json`), { force: true });
        globalThis.fetch = originalFetch;
        assert.deepEqual(errors, [], 'real host lifecycle must not produce agent errors');
        assert.deepEqual(unexpectedRequests, [], 'the observation tests must not silently accept unexpected traffic');
      });
      for (const plugin of hostPlugins) plugins.push(await ctx.plugin(plugin.default ?? plugin));
      const model = {
        async prepareCall(config, signal) {
          signal.throwIfAborted();
          return {
            config, adapterDefaults: {},
            async *stream(request) {
              modelCalls.push(request);
              yield { type: 'block-start', index: 0, blockType: 'text' };
              yield { type: 'text-delta', index: 0, text: 'Done' };
              yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done' } };
              yield { type: 'finish', reason: 'stop' };
            },
          };
        },
      };
      ctx.provide('llm', model);
      plugins.push(await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 }));
      ctx.provide('webServer', { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path); } });
      ctx.provide('connection', { requestRejection() {} });
      ctx.on('agent/error', ({ error }) => errors.push(error));
      plugins.push(await ctx.plugin(manager, { configPath, officialPackagePath }));
      let runtimePlugin;
      const load = async () => {
        runtimePlugin = await ctx.plugin(adapter);
        plugins.push(runtimePlugin);
        return ctx.hindsightRuntime;
      };
      if (loadRuntime) await load();
      const request = async (action, { sessionId, body } = {}) => {
        const route = `/plugins/dsh-hindsight-manager/${action}`;
        const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
        req.url = sessionId === undefined ? route : `${route}?sessionId=${encodeURIComponent(sessionId)}`;
        req.method = body === undefined ? 'GET' : 'POST';
        req.headers = {};
        let status;
        let result;
        await routes.get(route)(req, {
          writeHead(value) { status = value; }, end(value) { result = JSON.parse(value); },
        });
        assert.equal(status, 200, JSON.stringify(result));
        return result;
      };
      return {
        root, secondRoot, ctx, requests, modelCalls, model, responses,
        loadRuntime: load,
        async unloadRuntime() {
          plugins.splice(plugins.indexOf(runtimePlugin), 1);
          await runtimePlugin.dispose();
        },
        seed(rootPath = root) {
          // Exclude unrelated git/skill seeding without replacing the actual hooks.
          ctx.hindsightRuntime.workspaceFor(rootPath).seeded = Promise.resolve();
        },
        async createAgent(rootPath = root, { seed = true } = {}) {
          if (seed) this.seed(rootPath);
          const agent = await ctx.agentLoop.create(randomUUID(), { provider: 'test', model: 'test' }, { cwd: rootPath });
          agents.push(agent);
          return agent;
        },
        inspect: (sessionId) => request('runtime', { sessionId }),
        async save(set) {
          const result = await request('save', { body: { set, inherit: [] } });
          assert.equal(result.restartRequired, true);
          return result.settings;
        },
      };
    }

    const send = (agent, text) => agent.followup({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
    const records = (agent) => agent.session.snapshotEvents().filter((event) => event.type === RECALL_EVENT);
    const injected = (agent) => agent.session.snapshotEvents().filter((event) => event.type === 'user/message' && event.data.source.kind === 'plugin:hindsight');
    const lastRecord = (agent) => records(agent).at(-1).data;

    await suite.test('read-only runtime queries track late provider loading, real workspace caches and unloading', async (t) => {
      const f = await fixture(t, { loadRuntime: false });
      const agent = await f.createAgent(f.root, { seed: false });
      assert.equal((await f.inspect(agent.session.header.id)).status, 'runtime_unavailable');
      await f.loadRuntime();
      const cold = await f.inspect('historical-session-without-an-active-agent');
      assert.equal(cold.status, 'session_not_active');
      assert.equal(cold.effective, null);
      assert.equal(cold.runtime.upstreamVersion, manifest.version);
      assert.equal(cold.runtime.capabilities.runtimeInspection, true);
      assert.equal((await f.inspect(agent.session.header.id)).status, 'workspace_uninitialized');
      assert.equal(f.requests.length, 0, 'inspection must not initialize a workspace or access Hindsight');
      f.seed();
      const initialized = await f.inspect(agent.session.header.id);
      assert.equal(initialized.status, 'ready');
      assert.equal(initialized.effective.bankId, 'observations');
      assert.equal(initialized.effective.workspaceRoot, f.root);
      assert.equal(initialized.effective.autoInject, 'recall');
      await f.save({ autoInject: 'pages', positions: [{ dir: f.root, bank: 'changed-bank' }, { dir: f.secondRoot, bank: 'second-bank' }] });
      const cached = await f.inspect(agent.session.header.id);
      assert.deepEqual(cached.effective, initialized.effective, 'saving must not make cached runtime values look updated');
      const sameWorkspace = await f.createAgent();
      assert.deepEqual((await f.inspect(sameWorkspace.session.header.id)).effective, initialized.effective);
      const second = await f.createAgent(f.secondRoot);
      const newWorkspace = await f.inspect(second.session.header.id);
      assert.equal(newWorkspace.effective.autoInject, 'pages');
      assert.equal(newWorkspace.effective.bankId, 'second-bank');
      assert.equal(f.requests.length, 0, 'current state and cache checks require no memory requests');
      await f.unloadRuntime();
      assert.equal((await f.inspect(agent.session.header.id)).status, 'runtime_unavailable');
      await f.loadRuntime();
      assert.equal((await f.inspect(agent.session.header.id)).status, 'workspace_uninitialized');
      assert.equal((await f.inspect('cold-after-reload')).runtime.upstreamVersion, manifest.version);
      assert.equal(f.requests.length, 0);
    });

    await suite.test('real user turns persist correlated recall summaries while only the original memory text enters model context', async (t) => {
      const f = await fixture(t);
      f.responses.recall = () => Response.json({ results: [{ text: ' First usable memory ' }, { text: '' }, { text: '  ' }, { text: 'Second usable memory' }] });
      const agent = await f.createAgent();
      send(agent, 'Find the project decision');
      await agent.whenIdle();
      const completed = lastRecord(agent);
      assert.equal(completed.status, 'completed');
      assert.equal(completed.bodyPresent, true);
      assert.deepEqual(completed.stages[0].result, { unit: 'memories', count: 2 });
      assert.equal(completed.stages[0].httpStatus, 200);
      assert.ok(completed.totalDurationMs >= 0);
      assert.equal(records(agent)[0].data.status, 'running');
      const [message] = injected(agent);
      assert.ok(message, 'the real host must have committed the injection');
      assert.deepEqual(message.data.source.hindsight, { protocolVersion: 1, ownerTurn: completed.ownerTurn, recallId: completed.recallId, bodyPresent: true });
      assert.equal(f.modelCalls.length, 1);
      const content = f.modelCalls[0].messages.flatMap((message) => message.content).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
      assert.match(content, /First usable memory/);
      assert.match(content, /Second usable memory/);
      assert.doesNotMatch(content, /recallId|protocolVersion|totalDurationMs|plugin:dsh-hindsight-manager/);
      for (const event of records(agent)) {
        assert.equal(event.ignorable, true);
        assert.equal(event.data.turn, null);
        assert.equal(deriveEventMessage(event), null);
      }
      const restored = Session.create(randomUUID(), JSON.parse(JSON.stringify(agent.session.snapshotEvents())));
      assert.deepEqual(restored.snapshotEvents().filter((event) => event.type === RECALL_EVENT), records(agent));
      assert.deepEqual(restored.snapshotEvents().filter((event) => event.type === 'user/message' && event.data.source.kind === 'plugin:hindsight')[0].data.source, message.data.source);
      send(agent, 'Follow up in a new turn');
      await agent.whenIdle();
      const next = lastRecord(agent);
      assert.notEqual(next.recallId, completed.recallId);
      assert.notEqual(next.ownerTurn, completed.ownerTurn);
      assert.equal(injected(agent).length, 2, 'identical memory text must still be submitted for the new retrieval');
      assert.equal(f.requests.filter(({ path }) => path.endsWith('/memories/recall')).length, 2);
    });

    await suite.test('the host exposes empty success separately from upstream 404 without claiming a memory body', async (t) => {
      const f = await fixture(t);
      f.responses.recall = () => Response.json({ results: [] });
      const empty = await f.createAgent();
      send(empty, 'No saved facts');
      await empty.whenIdle();
      const noResults = lastRecord(empty);
      assert.equal(noResults.status, 'empty');
      assert.equal(noResults.stages[0].status, 'empty');
      assert.deepEqual(noResults.stages[0].result, { unit: 'memories', count: 0 });
      assert.equal(noResults.stages[0].httpStatus, 200);
      assert.equal(noResults.bodyPresent, false);
      assert.ok(injected(empty).every((event) => event.data.source.hindsight.bodyPresent === false));
      f.responses.recall = () => Response.json({ detail: 'Not found' }, { status: 404 });
      const missing = await f.createAgent();
      send(missing, 'A missing resource');
      await missing.whenIdle();
      const notFound = lastRecord(missing);
      assert.equal(notFound.status, 'failed');
      assert.equal(notFound.stages[0].status, 'not_found');
      assert.equal(notFound.stages[0].httpStatus, 404);
      assert.equal(notFound.stages[0].result, null);
      assert.equal(notFound.bodyPresent, false);
      assert.ok(injected(missing).every((event) => event.data.source.hindsight.bodyPresent === false));
    });

    await suite.test('cancelling in model preparation after retrieval leaves no committed source or model request', async (t) => {
      const f = await fixture(t);
      const entered = Promise.withResolvers();
      f.model.prepareCall = async (_config, signal) => {
        entered.resolve();
        await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      };
      const agent = await f.createAgent();
      send(agent, 'Cancel before submission');
      await entered.promise;
      const completed = lastRecord(agent);
      assert.equal(completed.status, 'completed');
      assert.equal(completed.bodyPresent, true);
      agent.cancel({ kind: 'user' });
      await agent.whenIdle();
      assert.equal(lastRecord(agent).status, 'completed', 'the adapter cannot invent cancellation after it has returned');
      assert.equal(injected(agent).length, 0);
      assert.equal(f.modelCalls.length, 0);
      assert.equal(f.requests.filter(({ path }) => path.endsWith('/memories/recall')).length, 1);
    });

    await suite.test('cancelling page-directory preparation preserves completed content retrieval and its separate interruption', async (t) => {
      const f = await fixture(t);
      const entered = Promise.withResolvers();
      f.responses.pagesTree = ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        entered.resolve();
      });
      const agent = await f.createAgent();
      send(agent, 'Cancel after content retrieval');
      await entered.promise;
      agent.cancel({ kind: 'user' });
      await agent.whenIdle();
      const completed = lastRecord(agent);
      assert.equal(completed.status, 'completed');
      assert.equal(completed.stages[0].status, 'completed');
      assert.deepEqual(completed.stages[0].result, { unit: 'memories', count: 1 });
      assert.deepEqual(completed.interruption, { phase: 'preparation', kind: 'cancelled' });
      assert.equal(completed.bodyPresent, null);
      assert.equal(injected(agent).length, 0);
      assert.equal(f.modelCalls.length, 0);
      assert.equal(f.requests.length, 2, 'content retrieval and page directory are the only requests');
    });
  });
}
