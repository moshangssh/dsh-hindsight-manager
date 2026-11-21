import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Duplex } from 'node:stream';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ACTIVITY_EVENT, createActivityTracker } from '../activity.js';
import { hostModule } from './host-modules.mjs';
const { Context } = await hostModule('@deepseek-ai/cordis');
const { Agent } = await hostModule('undici');

function session() {
  const events = [{ type: 'turn/start', seq: 0, data: { turn: 1 } }];
  return { events, snapshotEvents: () => events };
}

function tracker(t) {
  const activity = createActivityTracker((owner, type, data) => owner.events.push({ type, data, seq: owner.events.length }));
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
  const directory = await mkdtemp(join(tmpdir(), 'hindsight-activity-'));
  t.after(() => rm(directory, { recursive: true }));
  const script = join(directory, 'deepen.js');
  await writeFile(script, '');
  const ctx = lifecycle(activity);
  ctx.on('agent/session-start', async () => {
    const child = spawn(process.execPath, [script]);
    await once(child, 'exit');
  });
  await ctx.parallel('agent/session-start', { agent: { session: owner } });
  assert.equal(operations(owner).length, 0);
  observeTurn(activity, owner, 1);
  assert.deepEqual(operations(owner).map(({ turn, operation }) => [turn, operation.action, operation.status]), [[1, 'syncMemory', 'submitted']]);
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
