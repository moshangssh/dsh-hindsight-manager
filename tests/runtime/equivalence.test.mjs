import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import apiContract from '../fixtures/api-contract-1.2.3.json' with { type: 'json' };

const RECALL_EVENT = 'plugin:dsh-hindsight-manager/recall';
const SERVICE_URL = 'http://equivalence-memory.invalid';
const EVENT_TIME = Date.parse('2026-11-21T00:00:00.000Z');

const scenarios = [
  { name: 'recall filters empty text and retains identical repeated content', mode: 'recall',
    steps: ['same decision', 'same decision'], expectedQueries: ['same decision', 'same decision'] },
  { name: 'empty recall results retain the existing retry and frequency-zero behavior', mode: 'recall',
    config: { autoInjectEveryTurns: 0 }, steps: ['empty result', 'recovered result', 'cached result'],
    emptyFirstRecall: true, expectedQueries: ['empty result', 'recovered result'] },
  { name: 'frequency two skips cached decisions and tool continuations', mode: 'recall',
    config: { autoInjectEveryTurns: 2 }, steps: ['first decision', { continuation: true }, 'cached decision', 'next decision'],
    expectedQueries: ['first decision', 'next decision'] },
  { name: 'none preserves the first-turn page directory without retrieving body text', mode: 'none',
    steps: ['directory only'], expectedQueries: [] },
  { name: 'pages retrieves the same page content and directory', mode: 'pages', steps: ['page decision'] },
  { name: 'reflect preserves synthesis and the following cached decision', mode: 'reflect',
    config: { autoInjectEveryTurns: 0 }, steps: ['reflect decision', 'cached reflection'] },
  { name: 'reflect 503 follows pages empty then recall success', mode: 'reflect',
    fallback: true, steps: ['fallback decision'], expectedQueries: ['fallback decision'] },
  { name: 'caller cancellation during body retrieval preserves its error and recovery', mode: 'recall',
    steps: [{ cancelAt: '/memories/recall', text: 'cancelled decision' }, 'recovered decision'],
    expectedQueries: ['cancelled decision', 'recovered decision'] },
  { name: 'caller cancellation during directory preparation preserves retrieval and recovery', mode: 'recall',
    steps: [{ cancelAt: '/pages/tree', text: 'cancelled preparation' }, 'recovered preparation'],
    expectedQueries: ['cancelled preparation', 'recovered preparation'] },
  { name: 'session writeback preserves transcript content, timestamps and append requests', mode: 'recall',
    config: { retainSessions: true }, retain: true, steps: ['retain first decision', 'retain next decision'],
    expectedQueries: ['retain first decision', 'retain next decision'] },
];

function comparableDecision(decision) {
  return {
    ...decision,
    messages: decision.messages.map((message) => {
      const { hindsight: _observation, ...source } = message.source;
      if (source.kind === 'plugin:hindsight') assert.equal(typeof message.id, 'string');
      return { ...message, ...(source.kind === 'plugin:hindsight' ? { id: '<injected-message>' } : {}), source };
    }),
  };
}

// Only values owned by test-instance identity or wall-clock startup are normalized.
// Query bodies, content, configured options, user/assistant timestamps and request
// ordering remain exact. Reused operation ids keep their identity in the comparison.
function requestNormalizer(sessionId) {
  const operationIds = new Map();
  const operation = (id) => {
    if (!operationIds.has(id)) operationIds.set(id, `<operation-${operationIds.size + 1}>`);
    return operationIds.get(id);
  };
  return (url, method, rawBody) => {
    let normalizedUrl = url.href;
    const body = rawBody === undefined ? null : structuredClone(rawBody);
    if (url.pathname.endsWith('/memories') && method === 'POST') {
      if (Object.hasOwn(body, 'operation_id')) body.operation_id = operation(body.operation_id);
      for (const item of body.items) {
        assert.equal(item.document_id, `conversation:${sessionId}`);
        assert.equal(item.metadata.session_id, sessionId);
        assert.equal(item.metadata.ref_id, item.document_id);
        assert.ok(Number.isFinite(Date.parse(item.timestamp)), 'retain timestamp remains an ISO date');
        item.document_id = 'conversation:<session>';
        item.metadata.session_id = '<session>';
        item.metadata.ref_id = item.document_id;
        const rows = item.content.split('\n').map((line) => JSON.parse(line));
        if (rows[0].role === 'system' && rows[0].content === `REF-ID: conversation:${sessionId}`) {
          assert.equal(rows[0].timestamp, item.timestamp);
          rows[0].content = 'REF-ID: conversation:<session>';
          rows[0].timestamp = '<session-start>';
        }
        item.content = rows.map((row) => JSON.stringify(row)).join('\n');
        item.timestamp = '<session-start>';
      }
    }
    if (url.pathname.includes('/operations/')) {
      const id = decodeURIComponent(url.pathname.split('/').at(-1));
      assert.ok(operationIds.has(id), 'operation lookup must refer to an actual submission');
      normalizedUrl = `${url.origin}${url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1)}${operation(id)}${url.search}`;
    }
    return { url: normalizedUrl, method, body };
  };
}

async function runScenario(packagePath, scenario) {
  const directory = mkdtempSync(join(tmpdir(), 'hindsight-equivalence-'));
  const workspaceRoot = join(directory, 'project');
  mkdirSync(workspaceRoot);
  const configPath = join(directory, 'coding-agent.json');
  writeFileSync(configPath, JSON.stringify({
    serverMode: 'self-hosted', apiUrl: SERVICE_URL, bankId: 'equivalence',
    optInOnly: false, autoSeed: false, autoUpdate: false, retainSessions: false,
    autoInject: scenario.mode, autoInjectEveryTurns: 1,
    injectTimeoutMs: 7000, reflectTimeoutMs: 9000, pageRefreshEveryTurns: 3,
    recallOptions: { budget: 'mid', max_tokens: 923, types: ['observation', 'world'] },
    ...scenario.config,
  }));
  // Upstream's existing isolation variables locate fixture files, never user config.
  const originalEnvironment = new Map(Object.entries(process.env).filter(([name]) => name.startsWith('HINDSIGHT_')));
  for (const name of originalEnvironment.keys()) delete process.env[name];
  Object.assign(process.env, {
    HINDSIGHT_CONFIG: configPath,
    HINDSIGHT_LOG_FILE: join(directory, 'runtime.log'),
    HINDSIGHT_DIAG_FILE: join(directory, 'diagnostics.jsonl'),
    HINDSIGHT_USAGE_FILE: join(directory, 'usage.jsonl'),
  });
  const originalFetch = globalThis.fetch;
  const sessionId = randomUUID();
  const events = [];
  const records = [];
  const agent = { session: { header: { id: sessionId, cwd: workspaceRoot, origin: 'user' },
    snapshotEvents: () => events } };
  const requests = [];
  const decisions = [];
  const cancellations = [];
  const unexpected = [];
  const normalizeRequest = requestNormalizer(sessionId);
  let recallCount = 0;
  let cancellation;
  let runtime;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method ?? 'GET';
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    requests.push(normalizeRequest(url, method, body));
    assert.equal(url.origin, SERVICE_URL, 'only the in-process service stub is used');
    if (cancellation && url.pathname.endsWith(cancellation.suffix)) {
      const current = cancellation;
      cancellation = undefined;
      current.signal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        current.arrived.resolve();
      });
    }
    if (url.pathname.endsWith('/memories/recall')) {
      recallCount++;
      return Response.json({ results: scenario.emptyFirstRecall && recallCount === 1 ? [] : [
        { text: '  ' }, { text: `Saved decision for ${body.query}` }, { text: '' },
      ] });
    }
    if (url.pathname.endsWith('/pages/search')) return Response.json({ results: scenario.fallback ? [] : [
      { id: 'kp-decisions', name: 'Decisions', snippet: `Saved page for ${url.searchParams.get('q')}`, score: 0.75 },
    ] });
    if (url.pathname.endsWith('/reflect')) return scenario.fallback
      ? new Response('temporarily unavailable', { status: 503 })
      : Response.json({ text: 'The team previously chose an explicit project configuration.' });
    if (url.pathname.endsWith('/pages/tree')) return Response.json({ roots: [
      { id: 'kp-decisions', name: 'Decisions', kind: 'page', description: 'Recorded project decisions' },
    ] });
    if (url.pathname === '/v1/version') return Response.json({ api_version: apiContract.source.version });
    if (url.pathname.endsWith('/config')) return Response.json({ config: { store_document_text: true } });
    if (url.pathname.includes('/operations/')) return Response.json({ status: 'completed' });
    if (url.pathname.endsWith('/memories')) return Response.json({ operation_id: body.operation_id });
    unexpected.push(url.pathname);
    throw new Error(`Unexpected equivalence request: ${url.pathname}`);
  };
  try {
    const moduleUrl = pathToFileURL(join(packagePath, 'dist/dsh.js'));
    moduleUrl.searchParams.set('equivalence', randomUUID());
    const adapter = await import(moduleUrl.href);
    runtime = adapter.createDshRuntime(({ record }) => {
      const snapshot = structuredClone(record);
      records.push(snapshot);
      events.push({ type: RECALL_EVENT, data: snapshot });
    });
    const workspace = runtime.workspaceFor(workspaceRoot);
    workspace.seeded = Promise.resolve();
    for (const [index, step] of scenario.steps.entries()) {
      const turn = index + 1;
      const continuation = typeof step === 'object' && step.continuation;
      const text = typeof step === 'string' ? step : step.text;
      const controller = new AbortController();
      const decision = { kind: 'enter', startsRequestSeries: !continuation,
        selection: { provider: 'fixture', model: 'fixture' },
        messages: continuation ? [] : [{ id: `user-${turn}`, role: 'user', source: { kind: 'user' },
          content: [{ type: 'text', text }] }] };
      const execute = () => runtime.hooks.preStep({ agent, signal: controller.signal, turn, step: 0 }, async () => decision);
      if (typeof step === 'object' && step.cancelAt) {
        const pendingCancellation = { suffix: step.cancelAt, arrived: Promise.withResolvers() };
        cancellation = pendingCancellation;
        const reason = new Error('caller cancelled the fixture turn');
        const pending = execute();
        const rejected = assert.rejects(pending, (error) => {
          assert.equal(error, reason, 'cancellation must preserve the original caller reason');
          cancellations.push({ name: error.name, message: error.message, callerReasonPreserved: true });
          return true;
        });
        await pendingCancellation.arrived.promise;
        controller.abort(reason);
        await rejected;
        assert.equal(pendingCancellation.signal.aborted, true);
        assert.equal(workspace.core.turnCount.get(sessionId), undefined, 'cancelled preparation does not commit a completed turn');
        continue;
      }
      const result = await execute();
      decisions.push(comparableDecision(result));
      if (continuation) assert.equal(result, decision, 'tool continuation retains the original decision');
      for (const data of result.messages) events.push({ type: 'user/message', time: EVENT_TIME + turn * 1000, data });
      if (scenario.retain) {
        events.push({ type: 'tool/call', time: EVENT_TIME + turn * 1000 + 100,
          data: { name: 'read_file', arguments: JSON.stringify({ path: 'project.config.json' }) } });
        events.push({ type: 'assistant/message', time: EVENT_TIME + turn * 1000 + 200,
          data: { message: { role: 'assistant', content: [{ type: 'text', text: `Recorded answer ${turn}.` }] } } });
        await runtime.hooks.turnStopping({ agent, turn });
        await workspace.core.flush();
      }
    }
    await runtime.dispose();
    runtime = undefined;
    assert.deepEqual(unexpected, []);
    const recalls = requests.filter(({ url }) => new URL(url).pathname.endsWith('/memories/recall'));
    if (scenario.expectedQueries) assert.deepEqual(recalls.map(({ body }) => body.query), scenario.expectedQueries);
    const injections = decisions.flatMap(({ messages }) => messages.filter(({ source }) => source.kind === 'plugin:hindsight'));
    const injectionText = injections.flatMap(({ content }) => content.map(({ text }) => text)).join('\n');
    assert.ok(injections.length > 0, 'the fixture must exercise actual injected content');
    if (scenario.mode === 'none') {
      assert.doesNotMatch(injectionText, /<hindsight_memory>/);
      assert.match(injectionText, /<hindsight_pages>/);
      assert.equal(requests.length, 1);
      assert.ok(requests[0].url.endsWith('/pages/tree'));
    }
    if (scenario.mode === 'pages') {
      assert.equal(requests.filter(({ url }) => new URL(url).pathname.endsWith('/pages/search')).length, 1);
      assert.match(injectionText, /Saved page for page decision/);
    }
    if (scenario.mode === 'reflect' && !scenario.fallback) {
      assert.equal(requests.filter(({ url }) => new URL(url).pathname.endsWith('/reflect')).length, 1);
      assert.match(injectionText, /The team previously chose an explicit project configuration/);
    }
    if (scenario.fallback) {
      assert.deepEqual(requests.map(({ url }) => new URL(url).pathname), [
        '/v1/default/banks/equivalence/reflect', '/v1/default/banks/equivalence/pages/search',
        '/v1/default/banks/equivalence/memories/recall', '/v1/default/banks/equivalence/pages/tree',
      ]);
      assert.match(injectionText, /Saved decision for fallback decision/);
    }
    const retained = requests.filter(({ url, method }) => url.endsWith('/memories') && method === 'POST');
    const transcripts = retained.flatMap(({ body }) => body.items.map(({ content }) => content));
    if (scenario.retain) {
      assert.equal(transcripts.length, 2);
      assert.match(transcripts[0], /Recorded answer 1\./);
      assert.match(transcripts[1], /Recorded answer 2\./);
      assert.doesNotMatch(transcripts.join('\n'), /Saved decision|hindsight_memory|hindsight_pages/);
      assert.equal(retained[1].body.items[0].update_mode, 'append');
    } else assert.deepEqual(transcripts, []);
    return { comparison: { requests, decisions, cancellations, transcripts }, records };
  } finally {
    if (runtime) await runtime.dispose();
    globalThis.fetch = originalFetch;
    for (const name of Object.keys(process.env).filter((name) => name.startsWith('HINDSIGHT_'))) delete process.env[name];
    for (const [name, value] of originalEnvironment) process.env[name] = value;
    rmSync(join(tmpdir(), 'hindsight-dsh', `${sessionId}.json`), { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function registerEquivalenceTests(baselinePath, enhancedPath) {
  await test('adding observation preserves the migrated latest runtime behavior', async (suite) => {
    const baselineVersion = JSON.parse(readFileSync(join(baselinePath, 'package.json'), 'utf8')).version;
    const enhancedVersion = JSON.parse(readFileSync(join(enhancedPath, 'package.json'), 'utf8')).version;
    assert.equal(enhancedVersion, baselineVersion, 'compare observation against the same migrated upstream release');
    suite.diagnostic(`Baseline and enhanced runtime both use upstream ${baselineVersion}; HTTP is stubbed in process.`);
    for (const scenario of scenarios) {
      await suite.test(scenario.name, { timeout: 10000 }, async () => {
        const baseline = await runScenario(baselinePath, scenario);
        const enhanced = await runScenario(enhancedPath, scenario);
        assert.deepEqual(enhanced.comparison, baseline.comparison,
          'observation must preserve request order and payloads, message content, retention and cancellation propagation');
        assert.equal(baseline.records.length, 0, 'stage A is the migrated runtime without observation');
        assert.ok(enhanced.records.length > 0, 'stage B must exercise observation, not an unchanged baseline bundle');
      });
    }
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args.some((value) => !isAbsolute(value))) {
    throw new Error('Usage: node tests/runtime/equivalence.test.mjs /absolute/baseline-package /absolute/enhanced-package');
  }
  await registerEquivalenceTests(...args);
}
