import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import * as manager from '../../index.js';
import apiContract from '../fixtures/api-contract-1.2.3.json' with { type: 'json' };

// Called by the explicit CLI entry point, outside the independent tests/*.test.mjs suite.
export async function registerTests(officialPackagePath) {
  await test('manager settings reach the prepared official runtime', async (suite) => {
    const manifest = JSON.parse(readFileSync(join(officialPackagePath, 'package.json'), 'utf8'));
    const declaration = JSON.parse(readFileSync(join(officialPackagePath, 'dsh-enhancement.json'), 'utf8'));
    assert.deepEqual(declaration, {
      upstream: { name: '@vectorize-io/hindsight-coding-agents', version: '0.8.8' },
      patchSetVersion: '2', capabilities: {
        autoInjectEveryTurns: true, runtimeInspection: true, recallSummary: true, injectionCorrelation: true,
      },
      defaultsFile: 'dsh-memory.config.json',
    });
    assert.equal(manifest.name, declaration.upstream.name);
    assert.equal(manifest.version, declaration.upstream.version);
    assert.ok(manifest.files.includes('dsh-enhancement.json'));
    assert.ok(manifest.files.includes(declaration.defaultsFile));
    const policy = JSON.parse(readFileSync(join(officialPackagePath, declaration.defaultsFile), 'utf8'));
    suite.diagnostic(`Node ${process.version}; official package ${manifest.version}; patch set ${declaration.patchSetVersion}; API fixture ${apiContract.source.version}`);

    const directory = mkdtempSync(join(tmpdir(), 'dsh-manager-runtime-'));
    const configPath = join(directory, 'coding-agent.json');
    const workspace = join(directory, 'project');
    const otherWorkspace = join(directory, 'other-project');
    mkdirSync(workspace);
    mkdirSync(otherWorkspace);
    // These are the upstream test-isolation variables, not manager configuration inputs.
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
    suite.after(() => {
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env).filter((name) => name.startsWith('HINDSIGHT_'))) delete process.env[key];
      for (const [key, value] of previousEnvironment) process.env[key] = value;
      rmSync(directory, { recursive: true, force: true });
    });
    const adapter = await import(pathToFileURL(join(officialPackagePath, 'dist/dsh.js')));

    function fixture(t, initial = {}) {
      writeFileSync(configPath, JSON.stringify({
        serverMode: 'self-hosted', apiUrl: 'http://memory.invalid', bankId: 'manager-runtime',
        autoSeed: false, autoUpdate: false, ...initial,
      }));
      const routes = new Map();
      const cleanups = [];
      const context = {
        connection: { requestRejection() {} },
        webServer: { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path); } },
        effect(callback) { cleanups.push(callback()); },
        inject(services, callback) { if (services.every((name) => name in context)) return callback(context); },
      };
      manager.apply(context, { configPath, officialPackagePath });
      const requests = [];
      const unexpected = [];
      const documents = new Map();
      const runtimes = [];
      const sessions = [];
      const responses = {
        recall: ({ body }) => Response.json({ results: [{ text: `Memory about ${body.query}` }] }),
        pages: ({ url }) => Response.json({ results: [{ id: 'kp-test', name: 'Saved page', snippet: `Page about ${url.searchParams.get('q')}` }] }),
        reflect: ({ body }) => Response.json({ text: `Reflection about ${body.query}` }),
      };
      globalThis.fetch = async (input, options = {}) => {
        const url = new URL(input);
        const request = { url, path: url.pathname, body: options.body ? JSON.parse(options.body) : undefined, signal: options.signal };
        requests.push(request);
        assert.equal(url.origin, 'http://memory.invalid', 'only the mocked memory endpoint may be used');
        if (request.path.endsWith('/memories/recall')) return responses.recall(request);
        if (request.path.endsWith('/pages/search')) return responses.pages(request);
        if (request.path.endsWith('/reflect')) return responses.reflect(request);
        if (request.path.endsWith('/pages/tree')) return Response.json({ roots: [] });
        if (request.path === '/v1/version') return Response.json({ api_version: apiContract.source.version });
        if (request.path.endsWith('/config')) return Response.json({ config: { store_document_text: true } });
        if (request.path.includes('/operations/')) return Response.json({ status: 'completed' });
        if (request.path.endsWith('/memories')) {
          for (const item of request.body.items) documents.set(item.document_id, item.content);
          return Response.json({ operation_id: request.body.operation_id });
        }
        unexpected.push(request.path);
        throw new Error(`Unexpected request: ${request.path}`);
      };
      t.after(async () => {
        for (const runtime of runtimes) await runtime.dispose();
        for (const cleanup of cleanups) await cleanup();
        for (const id of sessions) rmSync(join(tmpdir(), 'hindsight-dsh', `${id}.json`), { force: true });
        assert.deepEqual(unexpected, []);
      });
      async function request(action, method = 'GET', body) {
        const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
        req.method = method;
        req.headers = {};
        let status;
        let result;
        await routes.get(`/plugins/dsh-hindsight-manager/${action}`)(req, {
          writeHead(value) { status = value; },
          end(value) { result = JSON.parse(value); },
        });
        assert.equal(status, 200, JSON.stringify(result));
        return result;
      }
      return {
        requests, responses, documents,
        raw: () => JSON.parse(readFileSync(configPath, 'utf8')),
        state: () => request('state'),
        async save(set = {}, inherit = []) {
          const result = await request('save', 'POST', { set, inherit });
          assert.equal(result.ok, true);
          assert.equal(result.restartRequired, true);
          return result.settings;
        },
        start() {
          const runtime = adapter.createDshRuntime();
          runtimes.push(runtime);
          for (const root of [workspace, otherWorkspace]) {
            // Prompt/stop coverage excludes the unrelated git and skill seeding job.
            runtime.workspaceFor(root).seeded = Promise.resolve();
          }
          return runtime;
        },
        agent(root = workspace) {
          const id = randomUUID();
          sessions.push(id);
          const events = [];
          return { session: { header: { id, cwd: root, origin: 'user' }, events, snapshotEvents: () => events } };
        },
        matching: (suffix) => requests.filter(({ path }) => path.endsWith(suffix)),
      };
    }

    async function prompt(runtime, agent, text, signal = new AbortController().signal) {
      const turn = agent.session.events.filter((event) => event.type === 'user/message' && event.data.source.kind === 'user').length + 1;
      const decision = {
        kind: 'enter', startsRequestSeries: true,
        messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }],
      };
      const result = await runtime.hooks.preStep({ agent, turn, signal }, async () => decision);
      for (const data of result.messages) agent.session.events.push({ type: 'user/message', data });
      return result.messages.filter((message) => message.source.kind === 'plugin:hindsight')
        .flatMap((message) => message.content.map(({ text: value }) => value)).join('\n');
    }

    async function stop(runtime, agent) {
      agent.session.events.push({ type: 'assistant/message', data: {
        message: { content: [{ type: 'text', text: 'The final answer.' }] },
      } });
      await runtime.hooks.turnStopping({ agent });
      await runtime.workspaceFor(agent.session.header.cwd).core.flush();
    }

    await suite.test('saved cadence and recall options control current-message requests, with no tool continuation recall', async (t) => {
      const f = fixture(t);
      const options = { budget: 'high', max_tokens: 777, types: null };
      const state = await f.save({ autoInject: 'recall', autoInjectEveryTurns: 2, recallOptions: options });
      assert.equal(state.autoInjectEveryTurns, 2);
      const runtime = f.start();
      const agent = f.agent();
      assert.match(await prompt(runtime, agent, 'database'), /Memory about database/);
      await prompt(runtime, agent, 'skipped topic');
      assert.match(await prompt(runtime, agent, 'style rules'), /Memory about style rules/);
      const calls = f.matching('/memories/recall');
      assert.deepEqual(calls.map(({ body }) => body.query), ['database', 'style rules']);
      for (const { body } of calls) for (const [key, value] of Object.entries(options)) assert.deepEqual(body[key], value);
      const continuation = { kind: 'enter', messages: [] };
      assert.equal(await runtime.hooks.preStep({ agent, signal: new AbortController().signal }, async () => continuation), continuation);
      assert.equal(f.matching('/memories/recall').length, 2);
      assert.equal(runtime.workspaceFor(workspace).core.turnCount.get(agent.session.header.id), 3);
    });

    await suite.test('frequency zero retains first-result retry semantics; inherited policy restores each-turn recall', async (t) => {
      const f = fixture(t);
      await f.save({ autoInject: 'recall', autoInjectEveryTurns: 0 });
      const runtime = f.start();
      const agent = f.agent();
      f.responses.recall = () => Response.json({ results: [] });
      await prompt(runtime, agent, 'empty first result');
      f.responses.recall = () => Response.json({ results: [{ text: 'A result is now available' }] });
      assert.match(await prompt(runtime, agent, 'try again'), /A result is now available/);
      await prompt(runtime, agent, 'already retrieved');
      assert.equal(f.matching('/memories/recall').length, 2);
      await runtime.dispose();
      const state = await f.save({}, ['autoInjectEveryTurns']);
      assert.equal(Object.hasOwn(f.raw().harnesses.dsh, 'autoInjectEveryTurns'), false);
      assert.equal(state.autoInjectEveryTurns, policy.autoInjectEveryTurns);
      assert.equal(policy.autoInjectEveryTurns, 1);
      const inherited = f.start();
      const next = f.agent();
      await prompt(inherited, next, 'new session');
      await prompt(inherited, next, 'another topic');
      assert.equal(f.matching('/memories/recall').length, 4);
    });

    await suite.test('saved mode changes preserve recall parameters and select pages, reflect, and recall requests', async (t) => {
      const f = fixture(t);
      const options = { budget: 'mid', max_tokens: 923, types: ['world', 'experience'] };
      await f.save({ autoInject: 'recall', recallOptions: options });
      const expected = { pages: '/pages/search', reflect: '/reflect', recall: '/memories/recall' };
      for (const [mode, endpoint] of Object.entries(expected)) {
        await f.save({ autoInject: mode });
        assert.deepEqual(f.raw().harnesses.dsh.recallOptions, { ...policy.recallOptions, ...options });
        const runtime = f.start();
        const start = f.requests.length;
        await prompt(runtime, f.agent(), `${mode} topic`);
        const retrievals = f.requests.slice(start).filter(({ path }) => Object.values(expected).some((suffix) => path.endsWith(suffix)));
        assert.equal(retrievals.length, 1);
        assert.ok(retrievals[0].path.endsWith(endpoint));
        if (mode === 'recall') for (const [key, value] of Object.entries(options)) assert.deepEqual(retrievals[0].body[key], value);
        await runtime.dispose();
      }
    });

    await suite.test('manager mappings route two workspaces to their banks while official bank overrides still apply', async (t) => {
      const f = fixture(t, { banks: { two: { recallOptions: { max_tokens: 321 } } } });
      await f.save({
        positions: [{ dir: workspace, bank: 'one' }, { dir: otherWorkspace, bank: 'two' }],
        autoInject: 'recall', recallOptions: { max_tokens: 765 },
      });
      const runtime = f.start();
      await prompt(runtime, f.agent(), 'first workspace');
      await prompt(runtime, f.agent(otherWorkspace), 'second workspace');
      const [one, two] = f.matching('/memories/recall');
      assert.match(one.path, /\/banks\/one\//);
      assert.match(two.path, /\/banks\/two\//);
      assert.equal(one.body.max_tokens, 765);
      assert.equal(two.body.max_tokens, 321);
    });

    await suite.test('disabling and restoring session retention leaves automatic recall independent', async (t) => {
      const f = fixture(t, { retainSessions: true });
      await f.save({ retainSessions: false, autoInject: 'recall' });
      const runtime = f.start();
      const agent = f.agent();
      await prompt(runtime, agent, 'recall without writing');
      await stop(runtime, agent);
      assert.equal(f.matching('/memories/recall').length, 1);
      assert.equal(f.matching('/memories').length, 0);
      await runtime.dispose();
      const state = await f.save({}, ['retainSessions']);
      assert.equal(Object.hasOwn(f.raw().harnesses.dsh, 'retainSessions'), false);
      assert.equal(state.retainSessions, true);
      const inherited = f.start();
      const next = f.agent();
      await prompt(inherited, next, 'retention restored');
      await stop(inherited, next);
      assert.equal(f.matching('/memories/recall').length, 2);
      assert.equal(f.matching('/memories').length, 1);
      assert.match(f.documents.get(`conversation:${next.session.header.id}`), /The final answer/);
    });

    await suite.test('none disables automatic retrieval body while tools, page roster, and retention remain available', async (t) => {
      const f = fixture(t);
      await f.save({ autoInject: 'none', retainSessions: true });
      const runtime = f.start();
      const agent = f.agent();
      const injection = await prompt(runtime, agent, 'remember this turn');
      assert.doesNotMatch(injection, /<hindsight_memory>/);
      assert.equal(f.matching('/memories/recall').length, 0);
      assert.equal(f.matching('/pages/search').length, 0);
      assert.equal(f.matching('/reflect').length, 0);
      assert.equal(f.matching('/pages/tree').length, 1);
      const registrations = [];
      adapter.apply({
        provide() {},
        emit() {},
        on() {},
        inject(_services, callback) { callback({ tools: { register(definition) { registrations.push(definition); } } }); },
        effect(callback) { t.after(callback()); },
      });
      const listPages = registrations.find(({ name }) => name === 'hindsight_list_pages');
      assert.ok(listPages, 'the official adapter must still register memory tools');
      await listPages.execute({}, { agent, signal: new AbortController().signal });
      assert.equal(f.matching('/pages/tree').length, 2);
      await stop(runtime, agent);
      assert.equal(f.matching('/memories').length, 1);
      assert.doesNotMatch(f.documents.get(`conversation:${agent.session.header.id}`), /hindsight_pages|hindsight_page_refresh|hindsight_memory/);
    });

    await suite.test('caller cancellation after a saved setting aborts retrieval without consuming the next turn', async (t) => {
      const f = fixture(t);
      await f.save({ autoInject: 'recall', autoInjectEveryTurns: 1 });
      const runtime = f.start();
      const agent = f.agent();
      await prompt(runtime, agent, 'previous topic');
      let started;
      const entered = new Promise((resolve) => { started = resolve; });
      f.responses.recall = ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        started();
      });
      const controller = new AbortController();
      const reason = new Error('stopped by the user');
      const pending = prompt(runtime, agent, 'current topic', controller.signal);
      const rejected = assert.rejects(pending, (error) => error === reason);
      await entered;
      controller.abort(reason);
      await rejected;
      assert.equal(runtime.workspaceFor(workspace).core.turnCount.get(agent.session.header.id), 1);
      assert.equal(f.matching('/memories/recall').at(-1).signal.aborted, true);
      f.responses.recall = () => Response.json({ results: [{ text: 'Current topic recovered' }] });
      const injection = await prompt(runtime, agent, 'current topic');
      assert.match(injection, /Current topic recovered/);
      assert.doesNotMatch(injection, /Memory about previous topic/);
    });

    for (const mode of ['recall', 'pages']) {
      await suite.test(`saved injectTimeoutMs cancels ${mode} while the caller remains active`, async (t) => {
        const f = fixture(t);
        await f.save({ autoInject: mode, injectTimeoutMs: 20 });
        const runtime = f.start();
        const agent = f.agent();
        let requestSignal;
        f.responses[mode] = ({ signal }) => new Promise((_resolve, reject) => {
          requestSignal = signal;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        const caller = new AbortController();
        // AbortSignal.timeout is unref'ed; this bounded test deadline keeps the process alive.
        let deadline;
        const failed = new Promise((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('configured retrieval deadline did not fire')), 2000); });
        t.after(() => clearTimeout(deadline));
        const injection = await Promise.race([prompt(runtime, agent, 'a slow search', caller.signal), failed]);
        clearTimeout(deadline);
        assert.equal(requestSignal.aborted, true);
        assert.equal(requestSignal.reason.name, 'TimeoutError');
        assert.equal(caller.signal.aborted, false);
        assert.doesNotMatch(injection, /<hindsight_memory>/);
      });
    }

    await suite.test('reflect fallback uses saved recall options and the pages/recall shared deadline', async (t) => {
      const f = fixture(t, { reflectTimeoutMs: 900 });
      const options = { budget: 'high', max_tokens: 654, types: ['observation'] };
      await f.save({ autoInject: 'reflect', injectTimeoutMs: 100, recallOptions: options });
      const runtime = f.start();
      let time = 1000;
      const timeouts = [];
      const reflectTimeouts = [];
      const originalTimeout = AbortSignal.timeout;
      const originalTimer = globalThis.setTimeout;
      t.mock.method(Date, 'now', () => time);
      t.mock.method(AbortSignal, 'timeout', (ms) => { timeouts.push(ms); return originalTimeout(ms); });
      t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
        reflectTimeouts.push(ms);
        return originalTimer(callback, ms, ...args);
      });
      f.responses.reflect = () => {
        time += 500;
        return new Response('temporarily unavailable', { status: 503 });
      };
      f.responses.pages = () => {
        time += 70;
        return Response.json({ results: [] });
      };
      assert.match(await prompt(runtime, f.agent(), 'a fallback topic'), /Memory about a fallback topic/);
      assert.deepEqual(timeouts.slice(0, 2), [100, 30], 'pages and recall share the remaining 100ms budget');
      assert.equal(reflectTimeouts[0], 900, 'injectTimeoutMs must not replace the reflect deadline');
      const calls = f.requests.filter(({ path }) => ['/reflect', '/pages/search', '/memories/recall'].some((suffix) => path.endsWith(suffix)));
      assert.equal(calls.length, 3);
      assert.ok(calls[0].path.endsWith('/reflect'));
      assert.ok(calls[1].path.endsWith('/pages/search'));
      for (const [key, value] of Object.entries(options)) assert.deepEqual(calls[2].body[key], value);
    });
  });
}
