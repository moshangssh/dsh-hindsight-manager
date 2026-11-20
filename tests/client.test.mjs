import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { apply } from '../index.js';

function fixture(patch = {}) {
  const defaults = {
    apiUrl: 'http://memory.invalid', serverMode: 'self-hosted', apiPort: 9077,
    configPath: '/temporary/coding-agent.json', apiTokenConfigured: false,
    positions: [{ dir: '/first', bank: 'first' }, { dir: '/second', bank: 'second' }],
    optInOnly: true, optInPaths: ['/approved'], retainSessions: true,
    autoInject: 'recall', autoInjectEveryTurns: 1, injectTimeoutMs: 7000,
    recallOptions: { types: ['observation', 'custom'], budget: 'low', max_tokens: 2000 },
  };
  return {
    ...defaults,
    overrides: Object.fromEntries(Object.keys(defaults).map((key) => [key, false])),
    sources: Object.fromEntries(Object.keys(defaults).map((key) => [key, { layer: 'global', key }])),
    inherited: { ...defaults, apiUrl: 'http://inherited.invalid', serverMode: 'daemon', apiPort: 9100,
      positions: [], optInOnly: false, optInPaths: [], retainSessions: false,
      autoInject: 'pages', autoInjectEveryTurns: 0, injectTimeoutMs: 5000,
      recallOptions: { types: null, budget: 'mid', max_tokens: 3000 } },
    configured: { ...defaults },
    enhancement: { status: 'declared', packagePath: '/official', upstreamVersion: '0.8.7', patchSetVersion: '1', autoInjectEveryTurns: true },
    options: { autoInjectModes: ['none', 'recall', 'pages', 'reflect'], recallBudgets: ['low', 'mid', 'high'], recallTypes: ['observation', 'world', 'experience'] },
    ...patch,
  };
}

// Exercise actual Page handlers. The harness observes keyed row identity, not browser focus.
async function renderPage(settings = fixture(), savedSettings = settings, bankResponse) {
  const values = [];
  const effects = [];
  let cursor = 0;
  let Page;
  const requests = [];
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat() }; },
    useState(initial) {
      const index = cursor++;
      if (!(index in values)) values[index] = initial;
      return [values[index], (value) => { values[index] = typeof value === 'function' ? value(values[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in values)) values[index] = { current: initial };
      return values[index];
    },
    useCallback(callback) { return callback; },
    useEffect(effect) { effects.push(effect); },
  };
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load({ factory }) { ({ Page } = factory(() => React)); } } },
    document: { createElement() { return { dataset: {}, remove() {} }; }, head: { appendChild() {} } },
    fetch: async (url, options) => {
      if (url.endsWith('/save')) {
        const operation = JSON.parse(options.body);
        requests.push(operation);
        return { ok: true, json: async () => ({ ok: true, settings: typeof savedSettings === 'function' ? await savedSettings(operation) : savedSettings }) };
      }
      if (url.endsWith('/banks')) return { ok: true, json: async () => bankResponse };
      return { ok: true, json: async () => settings };
    },
  });
  const render = () => {
    cursor = 0;
    return Page({ t: (key) => key });
  };
  render();
  for (const effect of effects.splice(0)) effect();
  await new Promise((resolve) => setImmediate(resolve));
  return { render, requests };
}

function findAll(node, predicate) {
  if (node === null || typeof node !== 'object') return [];
  return [...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => findAll(child, predicate))];
}
const rows = (tree) => findAll(tree, (node) => node.props.className === 'hm-item');
const button = (tree, label) => findAll(tree, (node) => node.type === 'button' && node.children[0] === label)[0];
const field = (tree, name) => findAll(tree, (node) => node.props.name === name)[0];
const restore = (tree, group) => findAll(tree, (node) => node.props['data-inherit'] === group)[0];
const text = (node) => typeof node === 'object' && node !== null ? node.children.map(text).join(' ') : String(node ?? '');
function change(page, name, value) {
  field(page.render(), name).props.onChange({ target: { value, checked: value } });
}

test('saving changes only the edited URL and resets the form to the saved result', async () => {
  const page = await renderPage(fixture(), fixture({ apiUrl: 'http://normalized.invalid' }));
  assert.equal(button(page.render(), 'save').props.disabled, true);
  await button(page.render(), 'save').props.onClick();
  assert.equal(page.requests.length, 0);
  change(page, 'apiUrl', 'http://edited.invalid/');
  await button(page.render(), 'save').props.onClick();
  assert.deepEqual(page.requests, [{ set: { apiUrl: 'http://edited.invalid/' }, inherit: [] }]);
  assert.equal(field(page.render(), 'apiUrl').props.value, 'http://normalized.invalid');
  assert.equal(button(page.render(), 'save').props.disabled, true);
  await button(page.render(), 'save').props.onClick();
  assert.equal(page.requests.length, 1);
});

test('changing a field back does not create an override', async () => {
  const page = await renderPage();
  change(page, 'apiUrl', 'http://edited.invalid');
  change(page, 'apiUrl', 'http://memory.invalid');
  await button(page.render(), 'save').props.onClick();
  assert.equal(page.requests.length, 0);
});

test('workspace rows keep identity while typing and adjacent rows are removed', async () => {
  const page = await renderPage();
  let tree = page.render();
  const firstKey = rows(tree)[0].props.key;
  const secondKey = rows(tree)[1].props.key;
  for (const value of ['/first/a', '/first/ab', '/first/abc']) {
    rows(tree)[0].children[0].props.onChange({ target: { value } });
    tree = page.render();
    assert.equal(rows(tree)[0].props.key, firstKey);
    assert.equal(rows(tree)[0].children[0].props.value, value);
  }
  button(rows(tree)[0], 'remove').props.onClick();
  tree = page.render();
  assert.equal(rows(tree)[0].props.key, secondKey);
  button(tree, 'add').props.onClick();
  tree = page.render();
  const addedKey = rows(tree)[1].props.key;
  assert.notEqual(addedKey, secondKey);
  assert.notEqual(addedKey, firstKey);
  rows(tree)[1].children[0].props.onChange({ target: { value: '/new' } });
  tree = page.render();
  assert.equal(rows(tree)[1].props.key, addedKey);
  await button(tree, 'save').props.onClick();
  assert.deepEqual(page.requests[0], { set: { positions: [
    { dir: '/second', bank: 'second' }, { dir: '/new', bank: '' },
  ] }, inherit: [] });
});

test('connection and recall inheritance preview and save group deletions', async () => {
  const initial = fixture();
  initial.overrides.apiUrl = true;
  initial.overrides.recallOptions = true;
  const page = await renderPage(initial);
  restore(page.render(), 'connection').props.onClick();
  assert.equal(field(page.render(), 'apiUrl').props.value, initial.inherited.apiUrl);
  restore(page.render(), 'recallOptions').props.onClick();
  assert.equal(field(page.render(), 'recallOptions.budget').props.value, 'mid');
  assert.equal(field(page.render(), 'recallOptions.max_tokens').props.value, '3000');
  assert.equal(field(page.render(), 'recallOptions.allTypes').props.checked, true);
  await button(page.render(), 'save').props.onClick();
  assert.deepEqual(page.requests[0], { set: {}, inherit: ['connection', 'recallOptions'] });
});

test('editing after restore cancels inheritance for that group', async () => {
  const initial = fixture();
  initial.overrides.apiUrl = true;
  const page = await renderPage(initial);
  restore(page.render(), 'connection').props.onClick();
  change(page, 'apiUrl', 'http://new.invalid');
  await button(page.render(), 'save').props.onClick();
  assert.deepEqual(page.requests[0], { set: { apiUrl: 'http://new.invalid' }, inherit: [] });
});

test('mode changes leave recall settings accessible and submit no unrelated fields', async () => {
  const page = await renderPage();
  for (const mode of ['pages', 'reflect', 'none']) {
    change(page, 'autoInject', mode);
    assert.equal(field(page.render(), 'recallOptions.budget').props.value, 'low');
    assert.equal(field(page.render(), 'recallOptions.types').props.value, '["observation","custom"]');
    assert.equal(field(page.render(), 'retainSessions').props.checked, true);
  }
  assert.match(text(page.render()), /recallFallbackHint/);
  await button(page.render(), 'save').props.onClick();
  assert.deepEqual(page.requests[0], { set: { autoInject: 'none' }, inherit: [] });
});

test('frequency zero, write-back false and recall subfield edits are explicit deltas', async () => {
  const page = await renderPage();
  change(page, 'autoInjectEveryTurns', '0');
  change(page, 'retainSessions', false);
  change(page, 'recallOptions.max_tokens', '3100');
  await button(page.render(), 'save').props.onClick();
  assert.deepEqual(page.requests[0], { set: {
    retainSessions: false, autoInjectEveryTurns: 0, recallOptions: { max_tokens: 3100 },
  }, inherit: [] });
});

test('recall types preserve custom strings and distinguish null from an empty array', async () => {
  const page = await renderPage();
  change(page, 'recallOptions.types', '["custom", "world"]');
  await button(page.render(), 'save').props.onClick();
  assert.deepEqual(page.requests[0].set.recallOptions, { types: ['custom', 'world'] });
  change(page, 'recallOptions.allTypes', true);
  await button(page.render(), 'save').props.onClick();
  assert.deepEqual(page.requests[1].set.recallOptions, { types: null });
  change(page, 'recallOptions.types', '[]');
  await button(page.render(), 'save').props.onClick();
  assert.deepEqual(page.requests[2].set.recallOptions, { types: [] });
});

test('frequency remains read-only without a matching installed declaration', async () => {
  for (const status of ['unlinked', 'undeclared', 'error']) {
    const page = await renderPage(fixture({ enhancement: { status, autoInjectEveryTurns: false, error: 'bad declaration' } }));
    assert.equal(field(page.render(), 'autoInjectEveryTurns').props.disabled, true);
    assert.equal(field(page.render(), 'autoInject').props.disabled, undefined);
    assert.match(text(page.render()), /enhancementUnlinked|enhancementUndeclared|bad declaration/);
  }
});

test('unknown configured values are visible and unchanged by editing another field', async () => {
  const initial = fixture();
  initial.configured.autoInject = 'future-mode';
  initial.configured.injectTimeoutMs = 'future-value';
  const page = await renderPage(initial);
  assert.match(text(page.render()), /future-mode/);
  assert.match(text(page.render()), /future-value/);
  change(page, 'retainSessions', false);
  await button(page.render(), 'save').props.onClick();
  assert.deepEqual(page.requests[0], { set: { retainSessions: false }, inherit: [] });
});

test('bank list reports the returned page count rather than claiming the full list', async () => {
  const page = await renderPage(fixture(), fixture(), { ok: true, banks: ['first', 'second'], total: 12, limit: 2, offset: 0 });
  await button(page.render(), 'refreshBanks').props.onClick();
  assert.match(text(page.render()), /2\s*\/\s*12/);
});

test('an unsupported frequency override can still be removed through inheritance', async () => {
  const initial = fixture({ enhancement: { status: 'undeclared', autoInjectEveryTurns: false } });
  initial.overrides.autoInjectEveryTurns = true;
  const page = await renderPage(initial);
  const control = restore(page.render(), 'autoInjectEveryTurns');
  assert.equal(control.props.disabled, false);
  control.props.onClick();
  await button(page.render(), 'save').props.onClick();
  assert.deepEqual(page.requests[0], { set: {}, inherit: ['autoInjectEveryTurns'] });
});

test('inheritance deletes a legacy alias even when the displayed value does not change', async () => {
  const initial = fixture();
  initial.overrides.autoInject = true;
  initial.inherited.autoInject = initial.autoInject;
  const page = await renderPage(initial);
  restore(page.render(), 'autoInject').props.onClick();
  await button(page.render(), 'save').props.onClick();
  assert.deepEqual(page.requests[0], { set: {}, inherit: ['autoInject'] });
});

test('empty mapping and an opt-in path change remain explicit operations', async () => {
  const page = await renderPage();
  button(rows(page.render())[0], 'remove').props.onClick();
  button(rows(page.render())[0], 'remove').props.onClick();
  change(page, 'optInPaths', '["/different"]');
  await button(page.render(), 'save').props.onClick();
  assert.deepEqual(page.requests[0], { set: { positions: [], optInPaths: ['/different'] }, inherit: [] });
});

test('invalid array input explains the error and keeps the draft without writing', async () => {
  const page = await renderPage();
  change(page, 'recallOptions.types', '["custom", 1]');
  await button(page.render(), 'save').props.onClick();
  assert.equal(page.requests.length, 0);
  assert.equal(field(page.render(), 'recallOptions.types').props.value, '["custom", 1]');
  assert.match(text(page.render()), /invalidArray/);
});

test('formatting-only number and JSON changes do not create explicit overrides', async () => {
  const page = await renderPage();
  change(page, 'autoInjectEveryTurns', '01');
  change(page, 'recallOptions.types', '[ "observation", "custom" ]');
  change(page, 'optInPaths', '[ "/approved" ]');
  await button(page.render(), 'save').props.onClick();
  assert.equal(page.requests.length, 0);
  assert.equal(button(page.render(), 'save').props.disabled, true);
});

test('trimming a URL or bank name without changing it does not create an override', async () => {
  const page = await renderPage();
  change(page, 'apiUrl', '  http://memory.invalid  ');
  rows(page.render())[0].children[1].props.onChange({ target: { value: ' first ' } });
  await button(page.render(), 'save').props.onClick();
  assert.equal(page.requests.length, 0);
});

test('custom numeric values remain visible as text and survive unrelated edits', async () => {
  const page = await renderPage(fixture({ autoInjectEveryTurns: 'custom-frequency', injectTimeoutMs: 'custom-timeout',
    recallOptions: { budget: 'future-budget', max_tokens: 'custom-token-budget', types: ['custom'] } }));
  for (const [name, value] of [['autoInjectEveryTurns', 'custom-frequency'], ['injectTimeoutMs', 'custom-timeout'], ['recallOptions.max_tokens', 'custom-token-budget']]) {
    assert.equal(field(page.render(), name).props.type, 'text');
    assert.equal(field(page.render(), name).props.value, value);
  }
  assert.equal(field(page.render(), 'recallOptions.budget').props.value, 'future-budget');
  change(page, 'retainSessions', false);
  await button(page.render(), 'save').props.onClick();
  assert.deepEqual(page.requests[0], { set: { retainSessions: false }, inherit: [] });
});

test('actual manager state renders and a control edit saves through the backend without replacing hidden recall fields', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hindsight-client-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'coding-agent.json');
  const original = { apiUrl: 'http://local.invalid', recallOptions: {
    budget: 'high', types: ['world', 'custom'], tags: ['project'], max_tokens: 2450,
  } };
  writeFileSync(configPath, JSON.stringify(original));
  const routes = new Map();
  const ctx = {
    webServer: { register({ path, handler }) { routes.set(path, handler); } },
    connection: { requestRejection() {} },
    effect(callback) { callback(); },
    inject(_services, callback) { callback(ctx); },
  };
  apply(ctx, { configPath, officialPackagePath: '' });
  const request = async (action, body) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = body === undefined ? 'GET' : 'POST';
    let result;
    await routes.get(`/plugins/dsh-hindsight-manager/${action}`)(req, {
      writeHead(status) { assert.equal(status, 200); },
      end(value) { result = JSON.parse(value); },
    });
    return result;
  };
  const page = await renderPage(await request('state'), async (operation) => (await request('save', operation)).settings);
  assert.equal(field(page.render(), 'autoInjectEveryTurns').props.disabled, true);
  assert.equal(field(page.render(), 'recallOptions.budget').props.value, 'high');
  change(page, 'recallOptions.max_tokens', '3450');
  await button(page.render(), 'save').props.onClick();
  assert.equal(field(page.render(), 'recallOptions.max_tokens').props.value, '3450');
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
    ...original, harnesses: { dsh: { recallOptions: { ...original.recallOptions, max_tokens: 3450 } } },
  });
  restore(page.render(), 'recallOptions').props.onClick();
  await button(page.render(), 'save').props.onClick();
  assert.equal(field(page.render(), 'recallOptions.max_tokens').props.value, '2450');
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).harnesses.dsh, {});
});

test('editing one recall option after restore cancels the preview without copying inherited sibling values', async () => {
  const initial = fixture();
  initial.overrides.recallOptions = true;
  const page = await renderPage(initial);
  restore(page.render(), 'recallOptions').props.onClick();
  assert.equal(field(page.render(), 'recallOptions.budget').props.value, 'mid');
  change(page, 'recallOptions.max_tokens', '4000');
  assert.equal(field(page.render(), 'recallOptions.budget').props.value, 'low');
  assert.equal(field(page.render(), 'recallOptions.types').props.value, '["observation","custom"]');
  await button(page.render(), 'save').props.onClick();
  assert.deepEqual(page.requests[0], { set: { recallOptions: { max_tokens: 4000 } }, inherit: [] });
});

test('non-string recall budgets render a visible read-only value and remain untouched until a known budget is chosen', async () => {
  const assertRenderChildren = (node) => {
    if (node === null || node === undefined || ['string', 'number', 'boolean'].includes(typeof node)) return;
    assert.equal(typeof node.type, 'string', 'React children must be elements or renderable primitives');
    assert.ok(Array.isArray(node.children));
    for (const child of node.children) assertRenderChildren(child);
  };
  for (const budget of [undefined, null, { custom: 'future' }]) {
    const initial = fixture();
    initial.recallOptions = { ...initial.recallOptions, budget };
    initial.configured.recallOptions = { ...initial.recallOptions };
    const page = await renderPage(initial);
    const tree = page.render();
    assertRenderChildren(tree);
    const select = field(tree, 'recallOptions.budget');
    const current = select.children.find((option) => option.props.value === select.props.value);
    assert.equal(current.props.disabled, true);
    assert.match(text(current), /undefined|null|\{"custom":"future"\}/);
    await button(tree, 'save').props.onClick();
    assert.equal(page.requests.length, 0);
    change(page, 'retainSessions', false);
    await button(page.render(), 'save').props.onClick();
    assert.deepEqual(page.requests[0], { set: { retainSessions: false }, inherit: [] });
    change(page, 'recallOptions.budget', 'high');
    await button(page.render(), 'save').props.onClick();
    assert.deepEqual(page.requests[1], { set: { recallOptions: { budget: 'high' } }, inherit: [] });
  }
});
