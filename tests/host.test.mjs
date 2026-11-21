import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { hostModule, hostUrl } from './host-modules.mjs';
const { Session, appendPluginRecord, deriveEventMessage } = await hostModule('@deepseek-ai/dsh-session');
import { ACTIVITY_EVENT, createActivityTracker, registerActivity } from '../activity.js';

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
