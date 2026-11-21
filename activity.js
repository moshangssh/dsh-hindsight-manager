import { AsyncLocalStorage } from 'node:async_hooks';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export const ACTIVITY_EVENT = 'plugin:dsh-hindsight-manager/activity';
const config = JSON.parse(readFileSync(new URL('./activity.config.json', import.meta.url), 'utf8'));
const requestRules = config.requests.map((rule) => ({ ...rule, pattern: new RegExp(rule.path) }));

// Agent lifecycle dispatch establishes the async owner for the official
// plugin's fire-and-forget work, including requests finishing in later turns.
export function createActivityTracker(appendRecord) {
  const context = new AsyncLocalStorage();
  let sessions = new WeakMap();
  const requests = new Map();
  const subscriptions = [];

  function sessionState(session) {
    let state = sessions.get(session);
    if (!state) {
      state = { observed: new Set(), startup: { session, turn: null, source: 'startup', pending: [] } };
      sessions.set(session, state);
    }
    return state;
  }

  function publish(scope, operation) {
    if (!sessions.has(scope.session)) return;
    if (scope.turn === null) {
      scope.pending.push(operation);
      return;
    }
    // turn:null keeps late background records from moving DSH's live timeline
    // cursor back to an older turn. ownerTurn is our own correlation field.
    appendRecord(scope.session, ACTIVITY_EVENT, { turn: null, ownerTurn: scope.turn, operation });
  }

  function enter(session, turn, source) {
    const state = sessionState(session);
    if (!state.observed.has(turn)) {
      state.observed.add(turn);
      appendRecord(session, ACTIVITY_EVENT, { turn: null, ownerTurn: turn, operation: null });
    }
    if (state.startup.turn === null) {
      state.startup.turn = turn;
      for (const operation of state.startup.pending) publish(state.startup, operation);
      state.startup.pending.length = 0;
    }
    return { session, turn, source };
  }

  function start(scope, action, success) {
    const operation = { id: randomUUID(), action, status: 'running' };
    publish(scope, operation);
    return {
      scope,
      success,
      finish(status) {
        publish(scope, { ...operation, status });
      },
    };
  }

  function listen(name, handler) {
    subscribe(name, handler);
    subscriptions.push([name, handler]);
  }

  listen('undici:request:create', ({ request }) => {
    const scope = context.getStore();
    if (!scope || scope.source === 'tool') return;
    const path = new URL(request.path, request.origin).pathname;
    // Only Hindsight bank API traffic in the observed lifecycle is activity.
    // Package updates and model requests have different API paths.
    if (!/^\/v1\/[^/]+\/banks(?:\/|$)/.test(path)) return;
    const rule = requestRules.find((item) => (item.method === '*' || item.method === request.method) && item.pattern.test(path));
    const action = scope.source === 'writeback' && request.method === 'POST' && path.endsWith('/memories')
      ? 'writeBack'
      : rule.action;
    requests.set(request, start(scope, action, rule.success));
  });
  listen('undici:request:headers', ({ request, response }) => {
    const operation = requests.get(request);
    if (operation) operation.statusCode = response.statusCode;
  });
  listen('undici:request:trailers', ({ request }) => {
    const operation = requests.get(request);
    if (!operation) return;
    requests.delete(request);
    operation.finish(operation.statusCode >= 200 && operation.statusCode < 300 ? operation.success : 'failed');
  });
  listen('undici:request:error', ({ request }) => {
    const operation = requests.get(request);
    if (!operation) return;
    requests.delete(request);
    operation.finish('failed');
  });
  listen('child_process', ({ process: child }) => {
    const scope = context.getStore();
    if (!scope || scope.source === 'tool') return;
    const report = (status) => {
      const script = child.spawnargs.find((arg) => Object.hasOwn(config.backgroundScripts, basename(arg)));
      if (script) start(scope, config.backgroundScripts[basename(script)], 'submitted').finish(status);
    };
    const spawned = () => {
      child.removeListener('error', failed);
      report('submitted');
    };
    const failed = () => {
      child.removeListener('spawn', spawned);
      report('failed');
    };
    child.once('spawn', spawned);
    child.once('error', failed);
  });

  return {
    observeDispatch(_mode, event, args) {
      const payload = args[0];
      if (event === 'agent/session-start') {
        context.enterWith(sessionState(payload.agent.session).startup);
      }
      if (event === 'agent/pre-step' || event === 'agent/turn-stopping') {
        context.enterWith(enter(payload.agent.session, payload.turn, event === 'agent/pre-step' ? 'recall' : 'writeback'));
      }
      if (event === 'agent/disposed') {
        sessions.delete(payload.agent.session);
      }
    },
    async tool(session, name, execute) {
      const turn = session.snapshotEvents().findLast((event) => event.type === 'turn/start').data.turn;
      const scope = enter(session, turn, 'tool');
      const rule = config.tools[name];
      // New upstream tools remain visible under their actual name.
      const operation = start(scope, rule ? rule.action : name, rule ? rule.success : 'completed');
      try {
        const result = await context.run(scope, execute);
        operation.finish(result.isError ? 'failed' : operation.success);
        return result;
      } catch (error) {
        operation.finish('failed');
        throw error;
      }
    },
    dispose() {
      for (const [name, handler] of subscriptions) unsubscribe(name, handler);
      requests.clear();
      sessions = new WeakMap();
      context.disable();
    },
  };
}

// Keep the settings panel usable without agent/tool services. DSH supplies
// dsh-session through its runtime resolver; no copy of the memory runtime ships.
export function registerActivity(ctx) {
  return ctx.inject(['agents', 'tools'], async (owner) => {
    const { appendPluginRecord } = await import('@deepseek-ai/dsh-session');
    const activity = createActivityTracker(appendPluginRecord);
    owner.effect(() => () => activity.dispose(), 'hindsight-manager: activity');
    owner.on('internal/dispatch', activity.observeDispatch);
    owner.on('tools/execute', (exec, next) => exec.name.startsWith('hindsight_')
      ? activity.tool(exec.agent.session, exec.name, next) : next());
  });
}
