import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const RECALL = 'plugin:dsh-hindsight-manager/recall';
const ACTIVITY = 'plugin:dsh-hindsight-manager/activity';
const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) });
const findAll = (node, predicate) => node === null || typeof node !== 'object' ? []
  : [...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => findAll(child, predicate))];
const text = (node) => node === null || node === undefined ? '' : typeof node === 'object'
  ? node.children.map(text).join(' ') : String(node);
const button = (tree, label) => findAll(tree, (node) => node.type === 'button' && text(node) === label)[0];

function loadClient({ hooks = {}, fetch, language = 'zh' } = {}) {
  const definitions = [];
  const views = new Map();
  const dictionaries = {};
  const ctx = {
    effect: (fn) => fn(),
    inject: (_deps, fn) => fn(ctx),
    locale: {
      register: (_name, values) => Object.assign(dictionaries, values),
      bind: () => (key) => dictionaries[language][key],
    },
    uiConversation: { events: { register: (definition) => definitions.push(definition) } },
    slots: { inject: (_name, fn) => fn(), register: (spec, view) => views.set(spec.key ?? spec.id, { spec, view }) },
  };
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => factory(() => ({ createElement, ...hooks })).apply(ctx) } },
    document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } },
    fetch, AbortController, Date,
  });
  return { definition: definitions[0], views, t: ctx.locale.bind(), dictionaries };
}

function inspection(patch = {}) {
  return {
    protocolVersion: 1, status: 'ready', hooksDisabled: false,
    runtime: { upstreamVersion: '0.8.8', patchSetVersion: '2', capabilities: {
      autoInjectEveryTurns: true, runtimeInspection: true, recallSummary: true, injectionCorrelation: true,
    } },
    effective: {
      workspaceRoot: '/project', bankId: 'project-bank', apiUrl: 'http://memory.internal',
      autoInject: 'recall', autoInjectEveryTurns: 1, retainSessions: true,
      injectTimeoutMs: 7000, recallOptions: { types: ['observation'], budget: 'low', max_tokens: 2000 },
    },
    ...patch,
  };
}

function record(patch = {}) {
  return {
    protocolVersion: 1, turn: null, ownerTurn: 1, recallId: 'recall-a', inspection: inspection(),
    requestedMode: 'recall', status: 'completed', interruption: null, degraded: false, skipReason: null,
    totalDurationMs: 320, stages: [{ mode: 'recall', status: 'completed', durationMs: 320,
      httpStatus: 200, errorKind: null, result: { unit: 'memories', count: 3 } }], bodyPresent: true,
    ...patch,
  };
}
const event = (type, data) => ({ type, data });
const submission = (patch = {}) => event('user/message', { source: { kind: 'plugin:hindsight', form: 'recall',
  hindsight: { protocolVersion: 1, ownerTurn: 1, recallId: 'recall-a', bodyPresent: true, ...patch } }, content: 'private memory' });

function replay(definition, events) {
  const contexts = new Map();
  for (const [seq, raw] of events.entries()) {
    const event = { ...raw, seq };
    const match = definition.match[event.type]?.(event);
    if (!match) continue;
    const item = { event, location: raw.location ?? (event.data.turn == null ? { kind: 'session' }
      : { kind: 'turn', turn: { turn: event.data.turn } }) };
    let context = contexts.get(match.id);
    if (context) context.state = definition.update(context, item);
    else {
      context = { id: match.id, key: `activity:${match.id}`, matches: [] };
      context.state = definition.start(context, item);
      contexts.set(match.id, context);
    }
    context.matches.push(item);
  }
  return [...contexts.values()].map((context) => definition.buildViewNode(context)).filter(Boolean);
}

function activity(events, language = 'zh') {
  const client = loadClient({ language });
  const nodes = replay(client.definition, events);
  return nodes.map((node) => ({ node, tree: client.views.get('hindsight-activity').view({ node, t: client.t }) }));
}

function runtimeHarness(language = 'zh') {
  const states = [];
  const effects = [];
  const pending = [];
  const requests = [];
  let cursor = 0;
  let currentSession = 'session-a';
  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (value) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = { current: initial };
      return states[index];
    },
    useEffect(fn, deps) {
      const index = cursor++;
      const previous = effects[index];
      if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      pending.push(() => {
        previous?.cleanup?.();
        effects[index] = { deps, cleanup: fn() };
      });
    },
  };
  const client = loadClient({ hooks, language, fetch: (url, options) => {
    const deferred = Promise.withResolvers();
    requests.push({ url, options, ...deferred });
    return deferred.promise;
  } });
  const slot = client.views.get('hindsight-runtime-status');
  assert.equal(slot.spec.name, 'conversation.session.header.utilities');
  const render = (sessionId = currentSession) => {
    currentSession = sessionId;
    cursor = 0;
    const tree = slot.view({ sessionId, t: client.t });
    findAll(tree, (node) => node.type === 'dialog')[0].props.ref.current = dialog;
    for (const effect of pending.splice(0)) effect();
    return tree;
  };
  const respond = async (index, body, { ok = true, status = 200 } = {}) => {
    requests[index].resolve({ ok, status, json: async () => body });
    await new Promise((resolve) => setImmediate(resolve));
  };
  const unmount = () => { for (const effect of effects) effect?.cleanup?.(); };
  return { render, requests, respond, unmount, dialog };
}

test('runtime dialog reads only when opened, switched or manually reloaded and ignores obsolete responses', async () => {
  const runtime = runtimeHarness();
  assert.equal(runtime.requests.length, 0);
  button(runtime.render(), 'Hindsight').props.onClick();
  assert.match(text(runtime.render()), /读取中/);
  assert.equal(runtime.dialog.open, true);
  assert.equal(runtime.requests.length, 1);
  assert.equal(runtime.requests[0].url, '/plugins/dsh-hindsight-manager/runtime?sessionId=session-a');
  runtime.render('session/b');
  assert.equal(runtime.requests[0].options.signal.aborted, true);
  assert.match(runtime.requests[1].url, /sessionId=session%2Fb$/);
  await runtime.respond(1, { ...inspection(), sessionId: 'session/b' });
  assert.match(text(runtime.render()), /project-bank/);
  assert.match(text(runtime.render()), /读取时间/);
  await runtime.respond(0, { ...inspection({ effective: { ...inspection().effective, bankId: 'obsolete-bank' } }), sessionId: 'session-a' });
  assert.doesNotMatch(text(runtime.render()), /obsolete-bank/);
  assert.equal(runtime.requests.length, 2);
  button(runtime.render(), '重新读取').props.onClick();
  runtime.render();
  assert.equal(runtime.requests.length, 3);
  assert.equal(runtime.requests[1].options.signal.aborted, true);
  runtime.unmount();
  assert.equal(runtime.requests[2].options.signal.aborted, true);
});

test('runtime switching hides old configuration before the new response and closing aborts the query', async () => {
  const runtime = runtimeHarness();
  button(runtime.render(), 'Hindsight').props.onClick();
  runtime.render();
  await runtime.respond(0, inspection());
  assert.match(text(runtime.render()), /project-bank/);
  assert.doesNotMatch(text(runtime.render('new-session')), /project-bank/);
  button(runtime.render(), '关闭').props.onClick();
  runtime.render();
  assert.equal(runtime.dialog.open, false);
  assert.equal(runtime.requests[1].options.signal.aborted, true);
  button(runtime.render(), 'Hindsight').props.onClick();
  runtime.render();
  assert.equal(runtime.requests.length, 3);
});

test('cold session inspection shows loaded runtime metadata without inventing effective configuration', async () => {
  const runtime = runtimeHarness();
  button(runtime.render(), 'Hindsight').props.onClick();
  runtime.render();
  await runtime.respond(0, inspection({ status: 'session_not_active', effective: null }));
  const tree = runtime.render();
  assert.match(text(tree), /当前会话未激活/);
  assert.match(text(tree), /0\.8\.8/);
  assert.match(text(tree), /运行状态查询/);
  assert.doesNotMatch(text(tree), /project-bank|http:\/\/memory.internal/);
  assert.ok(findAll(tree, (node) => node.type === 'time')[0].props.dateTime);
});

test('runtime interface absence and read errors are visible without claiming the plugin is absent', async () => {
  const runtime = runtimeHarness('en');
  button(runtime.render(), 'Hindsight').props.onClick();
  runtime.render();
  await runtime.respond(0, inspection({ status: 'runtime_unavailable', runtime: null, effective: null, hooksDisabled: null }));
  assert.match(text(runtime.render()), /does not provide a state interface/);
  assert.doesNotMatch(text(runtime.render()), /not installed/);
  button(runtime.render(), 'Reload').props.onClick();
  runtime.render();
  await runtime.respond(1, {}, { ok: false, status: 503 });
  const tree = runtime.render();
  assert.match(text(tree), /Failed to read runtime state: HTTP 503/);
  assert.equal(findAll(tree, (node) => node.props.role === 'alert').length, 1);
  assert.equal(button(tree, 'Reload').props.disabled, false);
});

test('hooks disabled is distinct from configured recall and write-back values', async () => {
  const runtime = runtimeHarness();
  button(runtime.render(), 'Hindsight').props.onClick();
  runtime.render();
  await runtime.respond(0, inspection({ hooksDisabled: true, effective: { ...inspection().effective, autoInjectEveryTurns: null } }));
  assert.match(text(runtime.render()), /已停用；配置开关仍显示实例原值/);
  assert.match(text(runtime.render()), /会话回写 开启/);
  assert.match(text(runtime.render()), /自动召回方式 检索事实/);
  assert.match(text(runtime.render()), /召回频率（用户回合） 未知/);
});

test('recall status is separate from confirmed body submission and never exposes memory content', () => {
  const events = [event('turn/start', { turn: 1 }), event(RECALL, record()), event('turn/end', { turn: 1 })];
  let [{ tree }] = activity(events);
  assert.match(text(tree), /召回完成/);
  assert.match(text(tree), /3 条可用记忆/);
  assert.match(text(tree), /已准备，待确认提交/);
  assert.doesNotMatch(text(tree), /已进入上下文/);
  [{ tree }] = activity([...events, submission()]);
  assert.match(text(tree), /已进入上下文/);
  assert.doesNotMatch(text(tree), /待确认提交|private memory/);
});

test('partial history source alone proves submission and final summary alone does not', () => {
  let [{ node, tree }] = activity([submission()]);
  assert.equal(node.data.recalls.length, 1);
  assert.match(text(tree), /检索详情未加载/);
  assert.match(text(tree), /已进入上下文/);
  assert.doesNotMatch(text(tree), /0 条|本轮未调用/);
  [{ tree }] = activity([event(RECALL, record())]);
  assert.match(text(tree), /未看到提交记录/);
  assert.doesNotMatch(text(tree), /已进入上下文/);
  [{ node, tree }] = activity([event(RECALL, record()), submission(), submission()]);
  assert.equal(node.data.recalls.length, 1);
  assert.doesNotMatch(text(tree), /检索详情未加载/);
});

test('a source with known turn location places partial history in its owner turn even when the first record is session scoped', () => {
  const location = { kind: 'step', turn: { turn: 7 }, step: { turn: 7, step: 1 } };
  const [{ node }] = activity([
    event(RECALL, record({ ownerTurn: 7 })),
    { ...submission({ ownerTurn: 7 }), location },
  ]);
  assert.equal(node.location, location);
  assert.equal(node.data.turn, 7);
});

test('same turn steering retains independent recalls and late records preserve submission evidence', () => {
  const [{ node, tree }] = activity([
    event('turn/start', { turn: 1 }),
    event(RECALL, record({ status: 'running', stages: [], totalDurationMs: null, bodyPresent: null })),
    submission(),
    event(RECALL, record()),
    event(RECALL, record({ recallId: 'recall-b', status: 'empty', bodyPresent: false,
      stages: [{ mode: 'pages', status: 'empty', durationMs: 22, httpStatus: 200, errorKind: null, result: { unit: 'pages', count: 0 } }] })),
    submission({ recallId: 'recall-b', bodyPresent: false }),
    event('turn/end', { turn: 1 }),
  ]);
  assert.equal(node.data.recalls.length, 2);
  assert.match(text(tree), /3 条可用记忆/);
  assert.match(text(tree), /0 个页面/);
  assert.match(text(tree), /仅提交目录／工具说明/);
  assert.match(text(tree), /已进入上下文/);
  assert.equal(findAll(tree, (node) => node.props.className === 'hm-recall').length, 2);
});

test('degraded retrieval reports successful fallback without making prior failures disappear', () => {
  const [{ tree }] = activity([event(RECALL, record({ requestedMode: 'reflect', degraded: true,
    stages: [
      { mode: 'reflect', status: 'failed', durationMs: 100, httpStatus: 503, errorKind: 'http', result: null },
      { mode: 'pages', status: 'empty', durationMs: 20, httpStatus: 200, errorKind: null, result: { unit: 'pages', count: 0 } },
      { mode: 'recall', status: 'completed', durationMs: 200, httpStatus: 200, errorKind: null, result: { unit: 'memories', count: 3 } },
    ] })),
    event(ACTIVITY, { turn: null, ownerTurn: 1, operation: { id: 'write', action: 'writeBack', status: 'submitted' } }),
  ]);
  assert.match(text(tree), /Hindsight · 召回已降级完成/);
  assert.match(text(tree), /推理合成 · 失败 · 100 ms\s+· HTTP 503/);
  assert.match(text(tree), /3 条可用记忆/);
  assert.match(text(tree), /回写会话 · 已提交/);
});

test('404 stays distinct from a successful empty result and reflect uses characters, not memory counts', () => {
  let [{ tree }] = activity([event(RECALL, record({ status: 'failed', bodyPresent: false,
    stages: [{ mode: 'recall', status: 'not_found', durationMs: 20, httpStatus: 404, errorKind: null, result: null }] }))]);
  assert.match(text(tree), /404，原因未确认/);
  assert.doesNotMatch(text(tree), /0 条|召回完成/);
  [{ tree }] = activity([event(RECALL, record({ requestedMode: 'reflect', stages: [
    { mode: 'reflect', status: 'completed', durationMs: 20, httpStatus: 200, errorKind: null, result: { unit: 'characters', count: 31 } },
  ] }))], 'en');
  assert.match(text(tree), /31 characters of synthesized text/);
  assert.doesNotMatch(text(tree), /usable memories/);
});

test('preparation interruption retains successful retrieval with unknown body and no submission claim', () => {
  const [{ tree }] = activity([event(RECALL, record({ bodyPresent: null,
    interruption: { phase: 'preparation', kind: 'cancelled' } }))]);
  assert.match(text(tree), /召回完成/);
  assert.match(text(tree), /320 ms/);
  assert.match(text(tree), /准备阶段已取消/);
  assert.match(text(tree), /正文组装结果未知 · 未看到提交记录/);
  assert.doesNotMatch(text(tree), /召回已取消|已进入上下文/);
});

test('skipped retrieval is not mislabeled as no activity or an actual retrieval call', () => {
  const [{ tree }] = activity([event(RECALL, record({ status: 'skipped', skipReason: 'cached_decision',
    stages: [], totalDurationMs: null, bodyPresent: false })), submission({ bodyPresent: false })]);
  assert.match(text(tree), /未执行检索/);
  assert.match(text(tree), /沿用已有召回决策/);
  assert.match(text(tree), /仅提交目录／工具说明/);
  assert.doesNotMatch(text(tree), /本轮未调用|Hindsight · 已调用|0 ms|0 条/);
});

test('unrelated user messages and unsupported protocol versions never create recall summaries', () => {
  assert.equal(activity([event('user/message', { source: { kind: 'user' }, content: 'hello' })]).length, 0);
  assert.equal(activity([event(RECALL, record({ protocolVersion: 2 })), submission({ protocolVersion: 2 })]).length, 0);
});
