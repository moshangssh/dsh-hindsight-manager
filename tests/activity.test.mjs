import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Duplex } from 'node:stream';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { registerHooks } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ACTIVITY_EVENT, RECALL_EVENT, createActivityTracker, registerActivity } from '../activity.js';
import { hostModule, hostUrl } from './host-modules.mjs';
const { Context } = await hostModule('@deepseek-ai/cordis');
const { Agent } = await hostModule('undici');

function session() {
  const events = [{ type: 'turn/start', seq: 0, data: { turn: 1 } }];
  return { events, snapshotEvents: () => events };
}

function tracker(t, getRuntime) {
  const activity = createActivityTracker((owner, type, data) => owner.events.push({ type, data, seq: owner.events.length }), getRuntime);
  t.after(() => activity.dispose());
  return activity;
}

function lifecycle(activity) {
  const ctx = new Context();
  ctx.on('internal/dispatch', activity.observeDispatch);
  return ctx;
}

function observeTurn(activity, owner, turn) {
  lifecycle(activity).waterfall('agent/pre-step', { agent: { session: owner }, turn }, () => {});
}

function operations(owner) {
  const items = new Map();
  for (const event of owner.events) {
    if (event.type === ACTIVITY_EVENT && event.data.operation) items.set(event.data.operation.id, { turn: event.data.ownerTurn, operation: event.data.operation });
  }
  return [...items.values()];
}

async function server(t, handler) {
  const url = 'http://hindsight.test';
  // Real Undici parsing and diagnostic events, using a byte-stream transport
  // instead of opening a listening socket. No external service is needed.
  const dispatcher = new Agent({ connect(_options, connected) {
    let request = '';
    let delivered = false;
    const socket = new Duplex({
      read() {},
      write(chunk, _encoding, done) {
        request += chunk.toString();
        const end = request.indexOf('\r\n\r\n');
        const length = Number(/content-length: (\d+)/i.exec(request)?.[1] ?? 0);
        if (!delivered && end !== -1 && request.length >= end + 4 + length) {
          delivered = true;
          const [method, path] = request.split(' ');
          let status = 200;
          handler({ method, url: path }, {
            writeHead(code) { status = code; },
            end(body) {
              socket.push(`HTTP/1.1 ${status} Response\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
            },
          });
        }
        done();
      },
    });
    socket.setNoDelay = socket.setKeepAlive = socket.ref = socket.unref = () => socket;
    queueMicrotask(() => connected(null, socket));
  } });
  t.after(() => dispatcher.destroy());
  return { url, fetch: (path, options) => fetch(path, { ...options, dispatcher }) };
}

test('tools record start/result, preserve errors and do not duplicate their HTTP requests', async (t) => {
  const activity = tracker(t);
  const owner = session();
  const { url, fetch } = await server(t, (_req, res) => res.end('{}'));
  const value = await activity.tool(owner, 'hindsight_read_page', async () => {
    assert.equal(operations(owner)[0].operation.status, 'running');
    await (await fetch(`${url}/v1/default/banks/test/pages/a`)).text();
    await (await fetch(`${url}/hindsight/v1/default/banks/test/pages/b`)).text();
    return 'private memory';
  });
  assert.equal(value, 'private memory');
  assert.equal(operations(owner).length, 1);
  assert.equal(operations(owner)[0].operation.status, 'completed');
  const failure = new Error('upstream failed');
  await assert.rejects(activity.tool(owner, 'hindsight_reflect', async () => { throw failure; }), (error) => error === failure);
  await activity.tool(owner, 'hindsight_ingest_document', async () => 'accepted');
  const normalizedError = { isError: true, error: { code: 'TOOL_FAILED' }, content: [] };
  assert.equal(await activity.tool(owner, 'hindsight_diagnose', async () => normalizedError), normalizedError);
  assert.deepEqual(operations(owner).map(({ operation }) => operation.status), ['completed', 'failed', 'submitted', 'failed']);
  assert.ok(!JSON.stringify(owner.events).includes('private memory'));
});

test('bank requests under proxy prefixes retain their actions and exclude unrelated paths', async (t) => {
  const activity = tracker(t);
  const owner = session();
  const { url, fetch } = await server(t, (_req, res) => res.end('{}'));
  const ctx = lifecycle(activity);
  ctx.on('agent/pre-step', async () => {
    for (const [method, path] of [
      ['POST', '/v1/default/banks/root/memories/recall'],
      ['POST', '/hindsight/v1/default/banks/single/memories/recall?budget=low'],
      ['GET', '/team/hindsight/v1/default/banks/nested/pages?limit=1'],
      ['GET', '/hindsight/v1/default/banks/single/new-resource'],
      ['GET', '/hindsight/v1/default/banks/single/operations'],
      ['POST', '/v1/chat/completions'],
      ['POST', '/hindsight/reflect'],
      ['GET', '/hindsight/v1/default/bankshop/a/pages'],
      ['GET', '/hindsight/not-v1/default/banks/a/pages'],
    ]) {
      await (await fetch(`${url}${path}`, { method })).text();
    }
  });
  ctx.on('agent/turn-stopping', async () => {
    await (await fetch(`${url}/team/hindsight/v1/default/banks/nested/memories?async=true`, { method: 'POST' })).text();
  });
  await ctx.waterfall('agent/pre-step', { agent: { session: owner }, turn: 1 }, () => {});
  await ctx.serial('agent/turn-stopping', { agent: { session: owner }, turn: 1 });
  assert.deepEqual(operations(owner).map(({ turn, operation }) => [turn, operation.action, operation.status]), [
    [1, 'autoRecall', 'completed'],
    [1, 'autoRecall', 'completed'],
    [1, 'autoPages', 'completed'],
    [1, 'memoryService', 'completed'],
    [1, 'syncStatus', 'completed'],
    [1, 'writeBack', 'submitted'],
  ]);
});

test('background requests keep their originating turn and session, even after turn/end', async (t) => {
  const activity = tracker(t);
  const a = session();
  const b = session();
  let releaseWrite;
  const writeArrived = Promise.withResolvers();
  const { url, fetch } = await server(t, (req, res) => {
    if (req.method === 'POST' && req.url.endsWith('/memories')) {
      releaseWrite = () => res.end('{"operation_id":"queued"}');
      writeArrived.resolve();
    } else res.end('{}');
  });
  let pending;
  const ctx = lifecycle(activity);
  ctx.on('agent/turn-stopping', () => {
    pending = fetch(`${url}/v1/default/banks/a/memories`, { method: 'POST', body: '{}' }).then((res) => res.text());
  });
  await ctx.serial('agent/turn-stopping', { agent: { session: a }, turn: 1 });
  await writeArrived.promise;
  a.events.push({ type: 'turn/end', seq: a.events.length, data: { turn: 1 } });
  a.events.push({ type: 'turn/start', seq: a.events.length, data: { turn: 2 } });
  ctx.on('agent/pre-step', async (_payload, next) => {
    await next();
    await (await fetch(`${url}/v1/default/banks/b/memories/recall`, { method: 'POST' })).text();
  });
  await ctx.waterfall('agent/pre-step', { agent: { session: b }, turn: 1 }, async () => {
    // Non-Hindsight traffic in the same lifecycle must not be counted.
    await (await fetch(`${url}/unrelated`)).text();
  });
  releaseWrite();
  await pending;
  assert.deepEqual(operations(a).map(({ turn, operation }) => [turn, operation.action, operation.status]), [[1, 'writeBack', 'submitted']]);
  assert.deepEqual(operations(b).map(({ turn, operation }) => [turn, operation.action, operation.status]), [[1, 'autoRecall', 'completed']]);
});

test('body query scope suppresses only its HTTP activity across concurrent sessions and leaves directories, tools and writeback visible', async (t) => {
  const bodyScope = new AsyncLocalStorage();
  let runtime = { queryScope: () => bodyScope.getStore() };
  const activity = tracker(t, () => runtime);
  const a = session();
  const b = session();
  const arrived = Promise.withResolvers();
  const requests = [];
  const { url, fetch } = await server(t, (req, res) => {
    requests.push(req);
    if (req.url.endsWith('/a/reflect')) arrived.resolve(res);
    else res.end('{}');
  });
  const ctx = lifecycle(activity);
  ctx.on('agent/pre-step', async ({ agent }) => {
    if (agent.session === a) {
      await bodyScope.run({ sessionId: 'a', ownerTurn: 1, recallId: 'recall-a' }, async () => {
        await (await fetch(`${url}/v1/default/banks/a/reflect`, { method: 'POST' })).text();
        await (await fetch(`${url}/v1/default/banks/a/pages/search`)).text();
        await (await fetch(`${url}/hindsight/v1/default/banks/a/memories/recall`, { method: 'POST' })).text();
      });
      await (await fetch(`${url}/v1/default/banks/a/pages/tree`)).text();
    } else {
      // This directory request happens while another session's body query waits.
      await (await fetch(`${url}/v1/default/banks/b/pages/tree`)).text();
      await bodyScope.run({ sessionId: 'b', ownerTurn: 1, recallId: 'recall-b' }, async () => {
        await (await fetch(`${url}/v1/default/banks/b/memories/recall`, { method: 'POST' })).text();
      });
    }
  });
  const pendingA = ctx.waterfall('agent/pre-step', { agent: { session: a }, turn: 1 }, () => {});
  const response = await arrived.promise;
  await ctx.waterfall('agent/pre-step', { agent: { session: b }, turn: 1 }, () => {});
  response.end('{}');
  await pendingA;
  await activity.tool(a, 'hindsight_read_page', async () => {
    await (await fetch(`${url}/v1/default/banks/a/pages/manual`)).text();
    return { isError: false };
  });
  ctx.on('agent/turn-stopping', async () => {
    await (await fetch(`${url}/v1/default/banks/a/memories`, { method: 'POST' })).text();
  });
  await ctx.serial('agent/turn-stopping', { agent: { session: a }, turn: 1 });
  assert.deepEqual(operations(a).map(({ operation }) => [operation.action, operation.status]), [
    ['autoPages', 'completed'], ['readPage', 'completed'], ['writeBack', 'submitted'],
  ]);
  assert.deepEqual(operations(b).map(({ operation }) => [operation.action, operation.status]), [['autoPages', 'completed']]);
  assert.equal(requests.length, 8, 'observation does not issue additional requests');

  runtime = undefined;
  const absentCtx = lifecycle(activity);
  absentCtx.on('agent/pre-step', async () => {
    await bodyScope.run({ sessionId: 'a', ownerTurn: 2, recallId: 'old-scope' }, async () => {
      await (await fetch(`${url}/v1/default/banks/a/memories/recall`, { method: 'POST' })).text();
    });
  });
  await absentCtx.waterfall('agent/pre-step', { agent: { session: a }, turn: 2 }, () => {});
  assert.deepEqual(operations(a).at(-1).turn, 2);
  assert.equal(operations(a).at(-1).operation.action, 'autoRecall', 'an unavailable provider retains legacy HTTP observations');
});

test('in-flight body requests keep their original provider across unload and replacement while directory and writeback remain visible', async (t) => {
  const sessionUrl = hostUrl('@deepseek-ai/dsh-session');
  const resolver = registerHooks({ resolve(name, context, next) {
    return name === '@deepseek-ai/dsh-session' ? { url: sessionUrl, shortCircuit: true } : next(name, context);
  } });
  t.after(() => resolver.deregister());
  const { Session } = await hostModule('@deepseek-ai/dsh-session');
  const ctx = new Context();
  ctx.provide('agents', {});
  ctx.provide('tools', {});
  let runtime;
  const manager = await ctx.plugin({ name: 'inflight-observer', async apply(owner) {
    owner.inject(['hindsightRuntime'], (active) => active.effect(() => {
      runtime = active.hindsightRuntime;
      return () => { runtime = undefined; };
    }));
    await registerActivity(owner, () => runtime);
  } });
  t.after(() => manager.dispose());
  const paused = Promise.withResolvers();
  const resumeWithoutProvider = Promise.withResolvers();
  const afterUnloadedRequest = Promise.withResolvers();
  const resumeWithReplacement = Promise.withResolvers();
  const paths = [];
  const { url, fetch } = await server(t, (req, res) => { paths.push(req.url); res.end('{}'); });
  const original = await ctx.plugin({ name: 'inflight-original-runtime', apply(owner) {
    const bodyScope = new AsyncLocalStorage();
    owner.provide('hindsightRuntime', { queryScope: () => bodyScope.getStore() });
    owner.on('agent/pre-step', async ({ agent, turn }) => {
      await bodyScope.run({ sessionId: agent.session.header.id, ownerTurn: turn, recallId: 'original-recall' }, async () => {
        paused.resolve();
        await resumeWithoutProvider.promise;
        await (await fetch(`${url}/v1/default/banks/a/pages/search`)).text();
        afterUnloadedRequest.resolve();
        await resumeWithReplacement.promise;
        await (await fetch(`${url}/v1/default/banks/a/memories/recall`, { method: 'POST' })).text();
      });
      await (await fetch(`${url}/v1/default/banks/a/pages/tree`)).text();
      owner.emit('hindsight/observation', { agent, record: {
        protocolVersion: 1, turn: null, ownerTurn: turn, recallId: 'original-recall', status: 'completed',
      } });
    });
  } });
  t.after(() => original.dispose());
  const a = Session.create('inflight-original-session');
  a.append('turn/start', { turn: 1 });
  const pending = ctx.waterfall('agent/pre-step', { agent: { session: a }, turn: 1 }, () => {});
  await paused.promise;
  await original.dispose();
  assert.equal(runtime, undefined);
  resumeWithoutProvider.resolve();
  await afterUnloadedRequest.promise;
  const replacement = await ctx.plugin({ name: 'inflight-replacement-runtime', apply(owner) {
    const bodyScope = new AsyncLocalStorage();
    owner.provide('hindsightRuntime', { queryScope: () => bodyScope.getStore() });
    owner.on('agent/pre-step', async ({ agent, turn }) => {
      await bodyScope.run({ sessionId: agent.session.header.id, ownerTurn: turn, recallId: 'replacement-recall' }, async () => {
        await (await fetch(`${url}/v1/default/banks/b/memories/recall`, { method: 'POST' })).text();
      });
      owner.emit('hindsight/observation', { agent, record: {
        protocolVersion: 1, turn: null, ownerTurn: turn, recallId: 'replacement-recall', status: 'completed',
      } });
    });
    owner.on('agent/turn-stopping', async () => {
      await (await fetch(`${url}/v1/default/banks/a/memories`, { method: 'POST' })).text();
    });
  } });
  t.after(() => replacement.dispose());
  resumeWithReplacement.resolve();
  await pending;
  const b = Session.create('inflight-replacement-session');
  b.append('turn/start', { turn: 1 });
  await ctx.waterfall('agent/pre-step', { agent: { session: b }, turn: 1 }, () => {});
  await ctx.serial('agent/turn-stopping', { agent: { session: a }, turn: 1 });
  assert.deepEqual(operations({ events: a.snapshotEvents() }).map(({ operation }) => [operation.action, operation.status]), [
    ['autoPages', 'completed'], ['writeBack', 'submitted'],
  ]);
  assert.deepEqual(operations({ events: b.snapshotEvents() }), []);
  assert.deepEqual(a.snapshotEvents().filter((event) => event.type === RECALL_EVENT).map((event) => event.data.recallId), ['original-recall']);
  assert.deepEqual(b.snapshotEvents().filter((event) => event.type === RECALL_EVENT).map((event) => event.data.recallId), ['replacement-recall']);
  assert.equal(paths.length, 5, 'only the existing retrieval, directory and writeback requests execute');
});

test('HTTP failure and aborted responses are visible, ordinary traffic is ignored', async (t) => {
  const activity = tracker(t);
  const owner = session();
  const pendingRequest = Promise.withResolvers();
  const { url, fetch } = await server(t, (req, res) => {
    if (req.url.endsWith('/reflect')) { pendingRequest.resolve(); return; }
    res.writeHead(503);
    res.end('{}');
  });
  await (await fetch(`${url}/v1/default/banks/outside/pages`)).text();
  const ctx = lifecycle(activity);
  ctx.on('agent/pre-step', async () => {
    await (await fetch(`${url}/v1/default/banks/a/pages`)).text();
    const controller = new AbortController();
    const request = fetch(`${url}/v1/default/banks/a/reflect`, { method: 'POST', signal: controller.signal });
    await pendingRequest.promise;
    controller.abort();
    await assert.rejects(request, { name: 'AbortError' });
  });
  await ctx.waterfall('agent/pre-step', { agent: { session: owner }, turn: 1 }, () => {});
  assert.deepEqual(operations(owner).map(({ operation }) => operation.status), ['failed', 'failed']);
});

test('startup work is attached to the first observed turn; a spawned sync is submitted, not completed', async (t) => {
  const activity = tracker(t);
  const owner = session();
  const { url, fetch } = await server(t, (_req, res) => res.end('{}'));
  const directory = await mkdtemp(join(tmpdir(), 'hindsight-activity-'));
  t.after(() => rm(directory, { recursive: true }));
  const script = join(directory, 'deepen.js');
  await writeFile(script, '');
  const ctx = lifecycle(activity);
  ctx.on('agent/created', async () => {
    await (await fetch(`${url}/v1/default/banks/startup/pages`)).text();
    const child = spawn(process.execPath, [script]);
    await once(child, 'exit');
  });
  await ctx.serial('agent/created', { agent: { session: owner }, source: 'startup' });
  assert.equal(operations(owner).length, 0);
  observeTurn(activity, owner, 1);
  assert.deepEqual(operations(owner).map(({ turn, operation }) => [turn, operation.action, operation.status]), [
    [1, 'autoPages', 'completed'],
    [1, 'syncMemory', 'submitted'],
  ]);
});

test('startup HTTP on resume stays on the first new turn when it finishes in a later turn', async (t) => {
  const activity = tracker(t);
  const owner = session();
  owner.events.push({ type: 'turn/end', seq: owner.events.length, data: { turn: 1 } });
  const arrived = Promise.withResolvers();
  const { url, fetch } = await server(t, (_req, res) => arrived.resolve(res));
  let pending;
  const ctx = lifecycle(activity);
  ctx.on('agent/created', () => {
    pending = fetch(`${url}/v1/default/banks/resumed/pages`).then((res) => res.text());
  });
  await ctx.serial('agent/created', { agent: { session: owner }, source: 'resume' });
  const response = await arrived.promise;
  assert.equal(operations(owner).length, 0);
  owner.events.push({ type: 'turn/start', seq: owner.events.length, data: { turn: 2 } });
  observeTurn(activity, owner, 2);
  owner.events.push({ type: 'turn/end', seq: owner.events.length, data: { turn: 2 } });
  owner.events.push({ type: 'turn/start', seq: owner.events.length, data: { turn: 3 } });
  observeTurn(activity, owner, 3);
  response.end('{}');
  await pending;
  assert.deepEqual(operations(owner).map(({ turn, operation }) => [turn, operation.action, operation.status]), [[2, 'autoPages', 'completed']]);
});

async function client() {
  const definitions = [];
  const views = new Map();
  const dictionaries = {};
  const createElement = (tag, props, ...children) => ({ tag, props, children });
  const ctx = {
    effect: (fn) => fn(),
    inject: (_deps, fn) => fn(ctx),
    locale: {
      register: (_name, values) => Object.assign(dictionaries, values),
      bind: () => (key) => dictionaries.zh[key],
    },
    uiConversation: { events: { register: (definition) => definitions.push(definition) } },
    slots: { inject: (_name, fn) => fn(), register: (spec, view) => views.set(spec.key ?? spec.id, { spec, view }) },
  };
  runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => factory(() => ({ createElement })).apply(ctx) } },
    document: { createElement: () => ({ dataset: {} }), head: { appendChild() {} } },
  });
  return { definition: definitions[0], render: views.get('hindsight-activity').view, t: ctx.locale.bind() };
}

function replay(definition, events) {
  const contexts = new Map();
  for (const event of events) {
    const match = definition.match[event.type]?.(event);
    if (!match) continue;
    const location = event.data.turn === null ? { kind: 'session' } : { kind: 'turn', turn: { turn: event.data.turn } };
    const item = { event, location };
    let context = contexts.get(match.id);
    if (!context) {
      context = { id: match.id, key: `activity:${match.id}`, matches: [] };
      context.state = definition.start(context, item);
      contexts.set(match.id, context);
    } else context.state = definition.update(context, item);
    context.matches.push(item);
  }
  return [...contexts.values()].map((context) => definition.buildViewNode(context));
}

function text(node) {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(text).join('');
  return (node.children ?? []).map(text).join('');
}

test('chat replays one collapsed row per turn, updates late writes in place and distinguishes zero calls', async (t) => {
  const { definition, render, t: translate } = await client();
  const activity = tracker(t);
  const owner = session();
  observeTurn(activity, owner, 1);
  assert.equal(replay(definition, owner.events)[0], null); // no premature "not called"
  owner.events.push({ type: 'turn/end', seq: owner.events.length, data: { turn: 1 } });
  let [node] = replay(definition, owner.events);
  assert.equal(text(render({ node, t: translate })), 'Hindsight · 本轮未调用');
  owner.events.push({ type: ACTIVITY_EVENT, seq: owner.events.length, data: { turn: null, ownerTurn: 1, operation: { id: 'write', action: 'writeBack', status: 'running' } } });
  [node] = replay(definition, owner.events);
  assert.equal(node.anchorSeq, 2);
  assert.match(text(render({ node, t: translate })), /正在调用/);
  owner.events.push({ type: 'turn/start', seq: owner.events.length, data: { turn: 2 } });
  observeTurn(activity, owner, 2);
  owner.events.push({ type: ACTIVITY_EVENT, seq: owner.events.length, data: { turn: null, ownerTurn: 1, operation: { id: 'write', action: 'writeBack', status: 'submitted' } } });
  const nodes = replay(definition, owner.events);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[1], null);
  node = nodes[0];
  assert.equal(node.anchorSeq, 2);
  assert.equal(node.data.operations.length, 1);
  assert.equal(node.location.turn.turn, 1);
  const view = render({ node, t: translate });
  assert.equal(view.tag, 'details');
  assert.equal(view.props.open, undefined);
  assert.match(text(view), /Hindsight · 已调用.*回写会话.*已提交/);
  assert.equal(replay(definition, [{ type: 'turn/end', seq: 1, data: { turn: 99 } }])[0], null); // unobserved history
});
