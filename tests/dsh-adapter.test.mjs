import assert from 'node:assert/strict';
import test from 'node:test';
import { agentFor, enterDecision, loadAdapter } from './load-adapter.mjs';

async function runtimeFixture() {
  const state = { bank: 'before', apiUrl: 'http://before.local', disabled: false };
  const cores = [];
  class RuntimeCore {
    constructor(client, bankId, cfg) {
      Object.assign(this, { client, bankId, cfg, seeded: 0, flushed: 0 });
      cores.push(this);
    }
    setTranscriptSource(read) { this.readTranscript = read; }
    seedIfCold() { this.seeded++; return Promise.resolve(); }
    async onPrompt() {}
    getInjection() { return 'memory'; }
    async onSessionIdle() {}
    async flush() { this.flushed++; }
    toolSpecs() {
      return [{
        name: 'hindsight_recall', description: 'Recall', inputSchema: {},
        handler: async (_args, signal) => {
          this.toolSignal = signal;
          return { content: [{ text: `${this.bankId}@${this.client.apiUrl}` }] };
        },
      }];
    }
  }
  const adapter = await loadAdapter({
    RuntimeCore,
    resolveHostMemory: () => ({ cfg: { disabled: state.disabled }, bankId: state.bank, client: { apiUrl: state.apiUrl } }),
  });
  const context = () => {
    const events = new Map();
    const tools = [];
    const disposers = [];
    return {
      events, tools, disposers,
      on(name, listener) { events.set(name, listener); },
      effect(effect) { const dispose = effect(); disposers.push(dispose); return dispose; },
      inject(_dependencies, callback) {
        callback({
          tools: { register(definition, options) { tools.push({ definition, options }); return () => {}; }, schemas: () => [] },
          effect(effect) { const dispose = effect(); disposers.push(dispose); return dispose; },
        });
      },
    };
  };
  return { adapter, state, cores, context };
}

test('memory injection preserves the host request-series boundary', async () => {
  const adapter = await loadAdapter();
  const core = { seedIfCold() {}, async onPrompt() {}, getInjection: () => 'remembered design' };
  const hooks = adapter.createDshHooks(() => ({ core, root: '/workspace' }));
  const result = await hooks.preStep({ agent: agentFor(), signal: new AbortController().signal }, async () => enterDecision());
  assert.equal(result.startsRequestSeries, true);
  assert.equal(result.messages.at(-1).content[0].text, 'remembered design');
});

test('stopping a step reaches recall and prevents late memory injection', async () => {
  const adapter = await loadAdapter();
  const controller = new AbortController();
  let receivedSignal;
  const core = {
    seedIfCold() {},
    async onPrompt(_session, _prompt, signal) {
      receivedSignal = signal;
      controller.abort();
    },
    getInjection: () => 'late memory',
  };
  const decision = enterDecision();
  const hooks = adapter.createDshHooks(() => ({ core, root: '/workspace' }));
  const result = await hooks.preStep({ agent: agentFor(), signal: controller.signal }, async () => decision);
  assert.equal(receivedSignal, controller.signal);
  assert.equal(result, decision);
});

test('host agent creation starts the workspace once', async () => {
  const { adapter, cores, context } = await runtimeFixture();
  const ctx = context();
  adapter.apply(ctx);
  assert.equal(typeof ctx.events.get('agent/created'), 'function');
  ctx.events.get('agent/created')({ agent: agentFor() });
  ctx.events.get('agent/created')({ agent: agentFor('/workspace', 'second-session') });
  assert.equal(cores[0].seeded, 1);
});

test('tool execution passes the host cancellation signal to the page tool', async () => {
  const { adapter, cores } = await runtimeFixture();
  const runtime = adapter.createDshRuntime();
  const tool = runtime.toolDefinitions('/workspace')[0];
  const signal = new AbortController().signal;
  assert.equal(await tool.execute({}, { agent: agentFor(), signal }), 'before@http://before.local');
  assert.equal(cores[0].toolSignal, signal);
});

test('saving a new bank and endpoint takes effect for existing and new sessions', async () => {
  const { adapter, state, cores } = await runtimeFixture();
  const runtime = adapter.createDshRuntime();
  const tool = runtime.toolDefinitions('/workspace')[0];
  const signal = new AbortController().signal;
  const agent = agentFor();
  assert.equal(await tool.execute({}, { agent, signal }), 'before@http://before.local');
  Object.assign(state, { bank: 'after', apiUrl: 'http://after.local' });
  await runtime.refresh();
  assert.equal(cores[0].flushed, 1);
  assert.equal(await tool.execute({}, { agent, signal }), 'after@http://after.local');
  assert.equal(await tool.execute({}, { agent: agentFor('/workspace', 'new-session'), signal }), 'after@http://after.local');
  state.disabled = true;
  await runtime.refresh();
  assert.equal(runtime.workspaceForAgent(agent), undefined);
  await assert.rejects(tool.execute({}, { agent, signal }), /disabled/);
  state.disabled = false;
  await runtime.refresh();
  assert.equal(await tool.execute({}, { agent, signal }), 'after@http://after.local');
});

test('standalone tool execution keeps the explicit root binding across refresh', async () => {
  const { adapter, state } = await runtimeFixture();
  const runtime = adapter.createDshRuntime();
  const tool = runtime.toolDefinitions('/workspace')[0];
  const signal = new AbortController().signal;
  assert.equal(await tool.execute({}, { signal }), 'before@http://before.local');
  state.bank = 'after';
  await runtime.refresh();
  assert.equal(await tool.execute({}, { signal }), 'after@http://before.local');
});

test('plugin instances keep independent configuration and live transcripts', async () => {
  const { adapter, state, cores, context } = await runtimeFixture();
  const first = context();
  adapter.apply(first);
  const agent = agentFor();
  agent.session.events.push({ type: 'user/message', data: 'private to first instance' });
  first.events.get('agent/created')({ agent });
  state.bank = 'second';
  const second = context();
  adapter.apply(second);
  const secondAgent = agentFor();
  second.events.get('agent/created')({ agent: secondAgent });
  assert.equal(cores.length, 2);
  assert.equal(cores[0].bankId, 'before');
  assert.equal(cores[1].bankId, 'second');
  assert.equal((await cores[0].readTranscript('session')).length, 1);
  assert.equal((await cores[1].readTranscript('session')).length, 0);
  await first.disposers[0]();
  assert.equal(cores[0].flushed, 1);
  assert.equal((await cores[0].readTranscript('session')).length, 0);
  assert.equal(cores[1].flushed, 0);
  const secondTool = second.tools[0].definition;
  assert.equal(await secondTool.execute({}, { agent: secondAgent, signal: new AbortController().signal }), 'second@http://before.local');
});

test('tools expose availability through registration options and exclude subagents', async () => {
  const { adapter, state, context } = await runtimeFixture();
  const ctx = context();
  adapter.apply(ctx);
  const registration = ctx.tools[0];
  assert.equal(registration.definition.when, undefined);
  assert.equal(registration.options.when({ agent: agentFor() }), true);
  const subagent = agentFor();
  subagent.session.header.origin = 'subagent';
  assert.equal(registration.options.when({ agent: subagent }), false);
  state.disabled = true;
  assert.equal(registration.options.when({ agent: agentFor('/disabled') }), false);
});
