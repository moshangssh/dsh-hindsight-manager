import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);

test('packed bundle imports in DSH without the source checkout or local peer links', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const temp = mkdtempSync(join(tmpdir(), 'dsh-package-test-'));
  try {
    await run('npm', ['--cache', join(temp, 'npm-cache'), 'pack', '--ignore-scripts', '--silent', '--pack-destination', temp], {
      cwd: root, encoding: 'utf8',
    });
    const archives = readdirSync(temp).filter((file) => file.endsWith('.tgz'));
    assert.equal(archives.length, 1);
    await run('tar', ['-xzf', join(temp, archives[0]), '-C', temp]);
    const packed = join(temp, 'package');
    const manifest = JSON.parse(readFileSync(join(packed, 'package.json'), 'utf8'));
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
    assert.equal(manifest.version, '0.5.0');
    assert.equal(manifest.engines.dsh, '0.2.2-rc.1');
    assert.equal(existsSync(join(packed, 'node_modules')), false);
    assert.equal(existsSync(join(packed, 'vendor')), false);
    assert.equal(manifest.exports['./runtime'], undefined);
    assert.equal(manifest.dependencies?.['@vectorize-io/hindsight-coding-agents'], undefined);
    assert.ok(existsSync(join(packed, 'manager.config.json')));
    assert.ok(existsSync(join(packed, 'activity.js')));
    assert.ok(existsSync(join(packed, 'activity.config.json')));
    for (const file of ['README.md', '0001-dsh-compatibility.patch', '0002-active-memory.patch', '0003-review-fixes.patch', '0004-enhancement-declaration.patch']) {
      assert.ok(existsSync(join(packed, 'runtime-patches', file)), `${file} must ship for offline use`);
    }
    for (const file of ['source.patch', 'delivery.patch']) {
      assert.ok(existsSync(join(packed, 'runtime-patches/0.8.8', file)), `${file} must ship for the latest supported runtime`);
    }
    assert.equal(manifest.scripts['test:runtime'], 'node scripts/test-runtime.mjs');
    assert.ok(existsSync(join(packed, 'scripts/test-runtime.mjs')));
    assert.ok(existsSync(join(packed, 'tests/runtime/settings.test.mjs')));
    assert.ok(existsSync(join(packed, 'tests/runtime/observations.test.mjs')));
    assert.ok(existsSync(join(packed, 'tests/host-modules.mjs')));
    assert.ok(existsSync(join(packed, 'tests/fixtures/api-contract-1.2.3.json')));
    assert.equal(existsSync(join(packed, 'dsh-enhancement.json')), false, 'the declaration belongs to the patched official package');
    await assert.rejects(run(process.execPath, ['scripts/test-runtime.mjs'], {
      cwd: packed, encoding: 'utf8',
    }), (error) => error.code === 1 && /Usage: npm run test:runtime/.test(error.stderr));
    const plugin = await import(pathToFileURL(join(packed, 'index.js')));
    assert.equal(typeof plugin.apply, 'function');
    assert.deepEqual(plugin.inject, ['webServer', 'connection']);

    const executable = process.env.PATH.split(delimiter).map((path) => join(path, 'dsh')).find(existsSync);
    assert.ok(executable, 'Install DSH to verify its actual bundle loader');
    const installation = dirname(dirname(realpathSync(executable)));
    const { loadProfileDirectory, generateConfigSchema } = await import(pathToFileURL(
      join(installation, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'),
    ));
    const profileDir = join(temp, 'profiles', 'test');
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true });
    symlinkSync(packed, join(profileDir, 'node_modules', manifest.name));
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'test-profile', private: true,
      dependencies: { [manifest.name]: `link:${packed}` },
      dsh: { profile: { bundles: [manifest.name] } },
    }));
    const anchor = join(installation, 'package.json');
    const profile = loadProfileDirectory('test', profileDir, anchor, { userLayer: false });
    assert.deepEqual(profile.skippedBundles, []);
    const schema = await generateConfigSchema(profile, profile.layers.map((layer) => layer.patches), anchor);
    assert.equal(schema['x-cordis'].complete, true);
    assert.deepEqual(schema['x-cordis'].diagnostics, []);
    assert.equal(schema['x-cordis'].entries[0].name, manifest.name);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
