import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

export async function loadAdapter(overrides = {}) {
  const bundle = await readFile(new URL('../vendor/hindsight-coding-agents/dist/dsh.js', import.meta.url), 'utf8');
  const source = bundle.slice(bundle.lastIndexOf('// src/dsh.ts'), bundle.indexOf('/*! Bundled license information:'));
  const context = vm.createContext({
    HINDSIGHT_PLUGIN: 'hindsight',
    process: { cwd: () => '/workspace' },
    randomUUID2: () => 'injection-id',
    diag() {},
    log: { debug() {} },
    readDshEvents: (events) => events,
    ...overrides,
  });
  const exports = source.match(/export \{([\s\S]*?)\};/)[1].trim().split(',').filter((entry) => entry.trim()).map((entry) => {
    const [local, exported] = entry.trim().split(/\s+as\s+/);
    return `${JSON.stringify(exported ?? local)}: ${local}`;
  });
  vm.runInContext(source.replace(/export \{[\s\S]*?\};/, `globalThis.adapter = {${exports.join(',')}};`), context);
  return context.adapter;
}

export function agentFor(root = '/workspace', id = 'session') {
  const events = [];
  return { session: { header: { cwd: root, id, origin: 'user' }, events, snapshotEvents: () => events } };
}

export function enterDecision() {
  return {
    kind: 'enter',
    startsRequestSeries: true,
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'Remember the design' }] }],
  };
}
