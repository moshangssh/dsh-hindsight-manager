import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { syncUpstream } from '../scripts/sync-upstream.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

async function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'hindsight-sync-test-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, 'manager');
  mkdirSync(root);
  for (const file of ['upstream-sync.json', 'patches', 'vendor', 'README.md', 'THIRD_PARTY_NOTICES.md']) {
    cpSync(join(repository, file), join(root, file), { recursive: true });
  }
  const config = readJson(join(root, 'upstream-sync.json'));
  const vendor = join(root, config.directory);
  const source = join(temp, 'package');
  cpSync(vendor, source, { recursive: true });
  cpSync(join(vendor, 'upstream-package.json'), join(source, 'package.json'));
  await run('git', ['apply', '--reverse', join(root, config.patch)], { cwd: source });
  const upstream = readJson(join(source, 'package.json'));
  upstream.version = `${upstream.version}-sync-test`;
  writeFileSync(join(source, 'package.json'), JSON.stringify(upstream));
  const tarball = join(temp, 'upstream.tgz');
  const pack = () => run('tar', ['-czf', tarball, '-C', temp, 'package']);
  return { root, vendor, source, config, upstream, tarball, pack };
}

function snapshot(root) {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return [path, readFileSync(path)];
    }));
}

test('a new upstream package keeps DSH changes, updates companions, and is idempotent', async (t) => {
  const f = await fixture(t);
  const currentRuntime = readFileSync(join(f.vendor, 'dist/dsh.js'), 'utf8');
  const currentLicense = readFileSync(join(f.vendor, 'LICENSE'));
  const marker = '// upstream release change outside the DSH patch\n';
  const runtime = join(f.source, 'dist/dsh.js');
  writeFileSync(runtime, marker + readFileSync(runtime, 'utf8'));
  for (const file of f.config.files.filter((file) => file !== 'dist/dsh.js')) {
    writeFileSync(join(f.source, file), marker + readFileSync(join(f.source, file), 'utf8'));
  }
  await f.pack();

  assert.deepEqual(await syncUpstream(f.root, { tarball: f.tarball }), { changed: true, version: f.upstream.version });
  assert.equal(readFileSync(join(f.vendor, 'dist/dsh.js'), 'utf8'), marker + currentRuntime);
  for (const file of f.config.files.filter((file) => file !== 'dist/dsh.js')) {
    assert.deepEqual(readFileSync(join(f.vendor, file)), readFileSync(join(f.source, file)));
  }
  assert.deepEqual(readJson(join(f.vendor, 'upstream-package.json')), f.upstream);
  assert.equal(readJson(join(f.vendor, 'package.json')).version, f.upstream.version);
  assert.ok(readFileSync(join(f.root, 'README.md'), 'utf8').includes(`Hindsight ${f.upstream.version}`));
  assert.ok(readFileSync(join(f.root, 'THIRD_PARTY_NOTICES.md'), 'utf8').includes(`version ${f.upstream.version},`));
  assert.deepEqual(readFileSync(join(f.vendor, 'LICENSE')), currentLicense);

  const before = snapshot(f.root);
  assert.deepEqual(await syncUpstream(f.root, { tarball: f.tarball }), { changed: false, version: f.upstream.version });
  assert.deepEqual(snapshot(f.root), before);
});

test('patch conflicts report failure before replacing the existing runtime or metadata', async (t) => {
  const f = await fixture(t);
  const runtime = join(f.source, 'dist/dsh.js');
  writeFileSync(runtime, readFileSync(runtime, 'utf8').replace(
    'function createDshHooks(resolve4) {', 'function upstreamChangedHooks(resolve4) {',
  ));
  await f.pack();
  const before = snapshot(f.root);
  await assert.rejects(syncUpstream(f.root, { tarball: f.tarball }), /patch failed|does not apply/);
  assert.deepEqual(snapshot(f.root), before);
});

test('a release missing a required companion leaves the current package unchanged', async (t) => {
  const f = await fixture(t);
  rmSync(join(f.source, 'dist/deepen.js'));
  await f.pack();
  const before = snapshot(f.root);
  await assert.rejects(syncUpstream(f.root, { tarball: f.tarball }), /ENOENT/);
  assert.deepEqual(snapshot(f.root), before);
});

test('the CLI accepts a local upstream archive without contacting npm', async (t) => {
  const f = await fixture(t);
  const script = join(f.root, 'scripts/sync-upstream.mjs');
  mkdirSync(dirname(script));
  cpSync(join(repository, 'scripts/sync-upstream.mjs'), script);
  await f.pack();
  await run('node', [script, '--tarball', f.tarball]);
  assert.equal(readJson(join(f.vendor, 'upstream-package.json')).version, f.upstream.version);
});
