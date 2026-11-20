import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

// Exercise the real Page and its event handlers without adding a browser dependency.
// React reconciles sibling rows by key; this checks identity, not browser focus itself.
async function renderPage() {
  const values = [];
  const effects = [];
  let cursor = 0;
  let Page;
  const requests = [];
  const settings = {
    apiUrl: 'http://memory.invalid',
    positions: [{ dir: '/first', bank: 'first' }, { dir: '/second', bank: 'second' }],
    optInOnly: true,
    retainSessions: true,
  };
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
        requests.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ ok: true, settings }) };
      }
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

test('workspace rows keep their identity while typing and when adjacent rows are removed', async () => {
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
  assert.equal(rows(tree)[0].children[0].props.value, '/second');
  button(tree, 'add').props.onClick();
  tree = page.render();
  const addedKey = rows(tree)[1].props.key;
  assert.notEqual(addedKey, secondKey);
  assert.notEqual(addedKey, firstKey);
  rows(tree)[1].children[0].props.onChange({ target: { value: '/new' } });
  tree = page.render();
  assert.equal(rows(tree)[1].props.key, addedKey);
  await button(tree, 'save').props.onClick();
  assert.deepEqual(page.requests[0].positions, [
    { dir: '/second', bank: 'second' },
    { dir: '/new', bank: '' },
  ], 'row identity belongs to the UI, not the saved configuration');
});
