import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleepWithSignal } from 'node:timers/promises';
import test from 'node:test';
import vm from 'node:vm';

const bundlePath = new URL('../vendor/hindsight-coding-agents/dist/dsh.js', import.meta.url);

async function loadRuntime(overrides = {}) {
  const bundle = await readFile(bundlePath, 'utf8');
  const section = (start, end) => {
    const from = bundle.indexOf(start);
    return bundle.slice(from, bundle.indexOf(end, from));
  };
  const source = [
    section('// src/core/hindsight.ts', '// src/core/config.ts'),
    section('async function syncStatus(', '// src/core/retain-cursor.ts'),
    section('// src/core/hook.ts', '// src/core/transcript-dsh.ts'),
  ].join('\n').replace(/^import .*;\n/gm, '');
  const schema = { describe() { return this; }, optional() { return this; } };
  let cache = {};
  const writes = [];
  const context = vm.createContext({
    AsyncLocalStorage, sleepWithSignal, AbortController, AbortSignal,
    setTimeout, clearTimeout, Response, Headers,
    process: { env: {}, cwd: () => '/workspace' },
    version: 'test',
    external_exports: { string: () => schema },
    describeError: (error) => error.message,
    setLogLevel() {},
    memoryCursorStore: () => new Map(),
    memoryUsageCursorStore: () => new Map(),
    stripInjectedMemory: (prompt) => prompt,
    sessionCacheFile: () => '/fake/session-cache',
    readSessionCache: () => cache,
    writeSessionCache: (_, next) => { cache = { ...cache, ...next }; writes.push(next); },
    buildReflectQuery: (prompt) => prompt,
    buildSystemInjection: (memory) => memory,
    buildPagesPreamble: () => 'first-turn guide',
    buildPageTrigger: () => ({ type: 'manual' }),
    parsePageList: (pages) => pages.items,
    brandWord: () => 'Hindsight',
    diag() {},
    diagFilePath: () => '/fake/diagnostics',
    log: { warn() {}, info() {} },
    fetch() { throw new Error('unexpected fetch'); },
    ...overrides,
  });
  vm.runInContext(`${source}\nglobalThis.api = { HindsightClient, RuntimeCore, buildPageTools };`, context);
  const client = new context.api.HindsightClient({
    apiUrl: 'http://memory.test', bank: 'test-bank',
    rateLimitPatienceMs: 60_000,
  });
  const tools = new Map(context.api.buildPageTools(client, 'test-bank', {
    repoDir: '/workspace', reflectTimeoutMs: 1_000,
  }).map((spec) => [spec.name, spec]));
  const core = new context.api.RuntimeCore(client, 'test-bank', {
    autoInject: 'reflect', reflectTimeoutMs: 1_000,
    injectTimeoutMs: 1_000, pageRefreshEveryTurns: 0,
  }, 'dsh', '/workspace');
  return { client, core, tools, writes };
}

function pendingRequest(init) {
  let resolve;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    init.signal.addEventListener('abort', () => no(init.signal.reason), { once: true });
  });
  return { promise, resolve, signal: init.signal };
}

function outcome(promise) {
  return promise.then((value) => ({ value }), (error) => ({ error }));
}

async function settleMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('concurrent calls sharing a client isolate cancellation and preserve its reason', async () => {
  const requests = [];
  const { tools } = await loadRuntime({ fetch: (_, init) => {
    const request = pendingRequest(init);
    requests.push(request);
    return request.promise;
  } });
  const first = new AbortController();
  const second = new AbortController();
  const tool = tools.get('hindsight_reflect');
  const firstResult = outcome(tool.handler({ query: 'first' }, first.signal));
  const secondResult = outcome(tool.handler({ query: 'second' }, second.signal));
  const reason = new Error('first call stopped');
  first.abort(reason);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].signal.aborted, false);
  requests[1].resolve(Response.json({ text: 'second succeeds' }));
  assert.equal((await firstResult).error, reason);
  assert.equal(JSON.parse((await secondResult).value.content[0].text), 'second succeeds');
});

test('an already aborted tool call performs no request', async () => {
  let requests = 0;
  const { tools } = await loadRuntime({ fetch: async () => {
    requests++;
    return Response.json({ roots: [] });
  } });
  const controller = new AbortController();
  const reason = new Error('already stopped');
  controller.abort(reason);
  await assert.rejects(tools.get('hindsight_list_pages').handler({}, controller.signal), (error) => error === reason);
  assert.equal(requests, 0);
});

test('caller cancellation also interrupts response body parsing', async () => {
  let received;
  const { tools } = await loadRuntime({ fetch: async (_, init) => {
    received = init.signal;
    return { ok: true, status: 200, json: () => new Promise((resolve, reject) => {
      received.addEventListener('abort', () => reject(received.reason), { once: true });
    }) };
  } });
  const controller = new AbortController();
  const result = outcome(tools.get('hindsight_list_pages').handler({}, controller.signal));
  await settleMicrotasks();
  const reason = new Error('body stopped');
  controller.abort(reason);
  assert.equal(received.aborted, true);
  assert.equal((await result).error, reason);
});

test('cancellation during credential refresh stops the 401 replay', async () => {
  const controller = new AbortController();
  const reason = new Error('refresh stopped');
  let requests = 0;
  const { client, tools } = await loadRuntime({ fetch: async () => {
    requests++;
    return new Response('', { status: 401 });
  } });
  client.tokenProvider = () => { controller.abort(reason); return 'new-token'; };
  await assert.rejects(tools.get('hindsight_list_pages').handler({}, controller.signal), (error) => error === reason);
  assert.equal(requests, 1);
});

test('a replayed 401 request retains caller cancellation', async () => {
  let request;
  let calls = 0;
  const { client, tools } = await loadRuntime({ fetch: async (_, init) => {
    if (++calls === 1) return new Response('', { status: 401 });
    request = pendingRequest(init);
    return request.promise;
  } });
  client.tokenProvider = () => 'new-token';
  const controller = new AbortController();
  const result = outcome(tools.get('hindsight_list_pages').handler({}, controller.signal));
  await settleMicrotasks();
  const reason = new Error('replay stopped');
  controller.abort(reason);
  assert.equal(request.signal.aborted, true);
  assert.equal((await result).error, reason);
  assert.equal(calls, 2);
});

test('rate-limit backoff is cancellable and never retries after cancellation', async () => {
  let requests = 0;
  let enteredBackoff;
  const backoffEntered = new Promise((resolve) => { enteredBackoff = resolve; });
  const { tools } = await loadRuntime({
    fetch: async () => { requests++; return new Response('', { status: 429 }); },
    sleepWithSignal: (...args) => { enteredBackoff(); return sleepWithSignal(...args); },
  });
  const controller = new AbortController();
  const result = outcome(tools.get('hindsight_list_pages').handler({}, controller.signal));
  await backoffEntered;
  const reason = new Error('backoff stopped');
  controller.abort(reason);
  assert.equal((await result).error, reason);
  assert.equal(requests, 1);
});

test('cancelled automatic reflection stops fallbacks and preserves first-turn state', async () => {
  const requests = [];
  let pending;
  let cancelNext = true;
  const { core, writes } = await loadRuntime({ fetch: async (url, init) => {
    requests.push(url);
    if (cancelNext) {
      pending = pendingRequest(init);
      return pending.promise;
    }
    return Response.json(url.endsWith('/reflect') ? { text: 'memory' } : { roots: [] });
  } });
  const controller = new AbortController();
  const result = outcome(core.onPrompt('session', 'remember', controller.signal));
  const reason = new Error('prompt stopped');
  controller.abort(reason);
  assert.equal(pending.signal.aborted, true);
  assert.equal((await result).error, reason);
  assert.equal(requests.length, 1);
  assert.equal(writes.length, 0);
  assert.equal(core.turnCount.has('session'), false);
  assert.equal(core.getInjection('session'), undefined);
  cancelNext = false;
  await core.onPrompt('session', 'remember', new AbortController().signal);
  assert.equal(core.turnCount.get('session'), 1);
  assert.match(core.getInjection('session'), /first-turn guide/);
});

test('cancellation inside the page fallback stops recall and page-roster requests', async () => {
  const requests = [];
  let pending;
  const { core, writes } = await loadRuntime({ fetch: async (url, init) => {
    requests.push(url);
    if (url.endsWith('/reflect')) return new Response('temporarily unavailable', { status: 503 });
    pending = pendingRequest(init);
    return pending.promise;
  } });
  const controller = new AbortController();
  const result = outcome(core.onPrompt('session', 'remember', controller.signal));
  await settleMicrotasks();
  assert.equal(requests.length, 2);
  assert.match(requests[1], /\/pages\/search\?/);
  const reason = new Error('fallback stopped');
  controller.abort(reason);
  assert.equal(pending.signal.aborted, true);
  assert.equal((await result).error, reason);
  assert.equal(requests.length, 2);
  assert.equal(writes.length, 0);
});

test('cancelled initiative folder lookup cannot continue to write requests', async () => {
  const requests = [];
  const { tools } = await loadRuntime({ fetch: (url, init) => {
    requests.push({ url, method: init.method });
    return pendingRequest(init).promise;
  } });
  const controller = new AbortController();
  const result = outcome(tools.get('hindsight_capture_initiative').handler({
    title: 'Example', summary: 'Example initiative',
  }, controller.signal));
  const reason = new Error('capture stopped');
  controller.abort(reason);
  assert.equal((await result).error, reason);
  assert.deepEqual(requests.map(({ method }) => method), ['GET']);
});

test('ordinary request errors still produce the existing tool error result', async () => {
  const { tools } = await loadRuntime({ fetch: async () => { throw new Error('connection failed'); } });
  const result = await tools.get('hindsight_list_pages').handler({}, new AbortController().signal);
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error, 'connection failed');
});

test('a tool deadline still aborts the request when its caller remains active', async () => {
  let received;
  const { tools } = await loadRuntime({ fetch: (_, init) => {
    received = init.signal;
    return pendingRequest(init).promise;
  } });
  const controller = new AbortController();
  const result = await tools.get('hindsight_reflect').handler({ query: 'remember' }, controller.signal);
  assert.equal(received.aborted, true);
  assert.equal(controller.signal.aborted, false);
  assert.equal(result.isError, true);
  assert.match(JSON.parse(result.content[0].text).error, /reflect timed out/);
});
