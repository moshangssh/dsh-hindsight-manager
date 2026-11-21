import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { hostModule, hostUrl } from './host-modules.mjs';
const { Session, appendPluginRecord, deriveEventMessage } = await hostModule('@deepseek-ai/dsh-session');
import { ACTIVITY_EVENT, RECALL_EVENT, createActivityTracker, registerActivity } from '../activity.js';
import managerConfig from '../manager.config.json' with { type: 'json' };

test('DSH stores and restores activity without adding it to the model context', async (t) => {
  const session = Session.create('hindsight-activity-host-test');
  session.append('turn/start', { turn: 1 });
  const activity = createActivityTracker(appendPluginRecord);
  t.after(() => activity.dispose());
  await activity.tool(session, 'hindsight_read_page', async () => 'private memory');
  const records = session.snapshotEvents().filter((event) => event.type === ACTIVITY_EVENT);
  assert.equal(records.length, 3);
  assert.equal(records[2].data.operation.status, 'completed');
  for (const record of records) {
    assert.equal(record.ignorable, true);
    assert.equal(record.data.turn, null);
    assert.equal(record.data.ownerTurn, 1);
    assert.equal(deriveEventMessage(record), null);
  }
  const restored = Session.create('hindsight-activity-restored', JSON.parse(JSON.stringify(session.snapshotEvents())));
  assert.deepEqual(restored.snapshotEvents().filter((event) => event.type === ACTIVITY_EVENT), records);
});

test('optional host observer registers without importing Hindsight and disposes with its plugin', async (t) => {
  const sessionUrl = hostUrl('@deepseek-ai/dsh-session');
  const resolver = registerHooks({ resolve(name, context, next) {
    return name === '@deepseek-ai/dsh-session' ? { url: sessionUrl, shortCircuit: true } : next(name, context);
  } });
  t.after(() => resolver.deregister());
  const { Context } = await hostModule('@deepseek-ai/cordis');
  const ctx = new Context();
  ctx.provide('agents', {});
  ctx.provide('tools', {});
  const plugin = await ctx.plugin({ name: 'activity-test', async apply(owner) { await registerActivity(owner); } });
  t.after(() => plugin.dispose());
  const session = Session.create('activity-observer-test');
  session.append('turn/start', { turn: 1 });
  const agent = { session };
  await ctx.waterfall('agent/pre-step', { agent, turn: 1 }, async () => ({ kind: 'enter', messages: [] }));
  const result = { isError: true, error: { code: 'TOOL_FAILED' }, content: [] };
  assert.equal(await ctx.waterfall('tools/execute', { name: 'hindsight_read_page', agent }, async () => result), result);
  assert.equal(session.snapshotEvents().at(-1).data.operation.status, 'failed');
  const count = session.snapshotEvents().length;
  await plugin.dispose();
  await ctx.waterfall('tools/execute', { name: 'hindsight_read_page', agent }, async () => result);
  assert.equal(session.snapshotEvents().length, count);
});

test('semantic recall records keep originating turns and survive host replay without becoming model messages', async (t) => {
  const sessionUrl = hostUrl('@deepseek-ai/dsh-session');
  const resolver = registerHooks({ resolve(name, context, next) {
    assert.equal(name.includes('hindsight-coding-agents'), false, 'the manager must not import a separate runtime');
    return name === '@deepseek-ai/dsh-session' ? { url: sessionUrl, shortCircuit: true } : next(name, context);
  } });
  t.after(() => resolver.deregister());
  const { Context } = await hostModule('@deepseek-ai/cordis');
  const ctx = new Context();
  ctx.provide('agents', {});
  ctx.provide('tools', {});
  const plugin = await ctx.plugin({ name: 'semantic-recall-test', async apply(owner) { await registerActivity(owner); } });
  t.after(() => plugin.dispose());
  const first = Session.create('semantic-recall-first');
  const second = Session.create('semantic-recall-second');
  const inspection = {
    protocolVersion: 1, status: 'ready', hooksDisabled: false,
    runtime: {
      upstreamVersion: managerConfig.supportedEnhancement.upstream.version,
      patchSetVersion: managerConfig.supportedEnhancement.patchSetVersion,
      capabilities: { autoInjectEveryTurns: true, runtimeInspection: true, recallSummary: true, injectionCorrelation: true },
    },
    effective: { workspaceRoot: '/project', bankId: 'project', apiUrl: 'http://memory.internal', autoInject: 'recall',
      autoInjectEveryTurns: 1, retainSessions: true, injectTimeoutMs: 7000,
      recallOptions: { budget: 'low', max_tokens: 2000, types: ['observation'] } },
  };
  const record = (recallId, ownerTurn, values = {}) => ({
    protocolVersion: 1, turn: null, ownerTurn, recallId, inspection,
    requestedMode: 'recall', status: 'running', interruption: null, degraded: false,
    skipReason: null, totalDurationMs: null, stages: [], bodyPresent: null, ...values,
  });
  first.append('turn/start', { turn: 1 });
  first.append('user/message', { id: 'human-message', role: 'user', content: [{ type: 'text', text: 'Find the project decision' }],
    source: { kind: 'human' }, turn: 1 }, { surfaceOp: 'append' });
  first.append('turn/end', { turn: 1 });
  first.append('turn/start', { turn: 2 });
  second.append('turn/start', { turn: 1 });
  const before = first.deriveMessages();
  const send = (session, value) => ctx.emit('hindsight/observation', { agent: { session }, record: value });
  send(first, record('first-a', 1));
  send(second, record('second-a', 1, { status: 'skipped', skipReason: 'mode_none' }));
  const completed = record('first-a', 1, { status: 'completed', totalDurationMs: 12, bodyPresent: true,
    stages: [{ mode: 'recall', status: 'completed', durationMs: 12, httpStatus: 200, errorKind: null,
      result: { unit: 'memories', count: 2 } }] });
  send(first, completed);
  // Multiple messages in one owner turn retain independent recall identities.
  send(first, record('first-b', 1, { status: 'empty', totalDurationMs: 4, bodyPresent: false,
    stages: [{ mode: 'recall', status: 'empty', durationMs: 4, httpStatus: 200, errorKind: null,
      result: { unit: 'memories', count: 0 } }] }));
  completed.stages[0].result.count = 99;
  const records = first.snapshotEvents().filter((event) => event.type === RECALL_EVENT);
  assert.equal(records.length, 3);
  assert.equal(records[1].data.stages[0].result.count, 2, 'the host snapshots mutable observation payloads');
  assert.deepEqual(records.map(({ data }) => [data.turn, data.ownerTurn, data.recallId]), [
    [null, 1, 'first-a'], [null, 1, 'first-a'], [null, 1, 'first-b'],
  ]);
  for (const event of records) {
    assert.equal(event.ignorable, true);
    assert.equal(deriveEventMessage(event), null);
  }
  assert.deepEqual(first.deriveMessages(), before);
  assert.deepEqual(second.snapshotEvents().filter((event) => event.type === RECALL_EVENT).map(({ data }) => data.recallId), ['second-a']);
  const restored = Session.create('semantic-recall-restored', JSON.parse(JSON.stringify(first.snapshotEvents())));
  assert.deepEqual(restored.snapshotEvents().filter((event) => event.type === RECALL_EVENT), records);
  assert.deepEqual(restored.deriveMessages(), before);

  await plugin.dispose();
  send(first, record('after-unload', 2));
  assert.equal(first.snapshotEvents().filter((event) => event.type === RECALL_EVENT).length, 3);
});
