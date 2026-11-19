import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

export async function syncUpstream(root, { tarball } = {}) {
  const config = readJson(join(root, 'upstream-sync.json'));
  const vendor = join(root, config.directory);
  const previous = readJson(join(vendor, 'upstream-package.json'));
  const temp = mkdtempSync(join(tmpdir(), 'hindsight-upstream-'));
  const run = async (command, args, cwd = temp) => (await execute(command, args, { cwd, encoding: 'utf8' })).stdout;
  try {
    let archive;
    if (tarball) {
      archive = resolve(root, tarball);
    } else {
      const npmArgs = ['--registry', config.registry, '--cache', join(temp, 'npm-cache')];
      const version = JSON.parse(await run('npm', [
        ...npmArgs, 'view', `${config.package}@${config.target}`, 'version', '--json',
      ]));
      if (version === previous.version) return { changed: false, version };
      const [packed] = JSON.parse(await run('npm', [
        ...npmArgs, 'pack', `${config.package}@${version}`, '--ignore-scripts', '--json',
        '--pack-destination', temp,
      ]));
      archive = join(temp, packed.filename);
    }

    await run('tar', ['-xzf', archive, '-C', temp]);
    const source = join(temp, 'package');
    const upstream = readJson(join(source, 'package.json'));
    if (upstream.name !== config.package) {
      throw new Error(`Expected ${config.package}, received ${upstream.name}`);
    }
    if (upstream.version === previous.version) return { changed: false, version: upstream.version };

    // Apply only the maintained DSH changes; conflicts are reported by git for manual porting.
    await run('git', ['apply', join(root, config.patch)], source);
    const candidate = join(temp, 'candidate');
    for (const file of config.files) {
      mkdirSync(dirname(join(candidate, file)), { recursive: true });
      cpSync(join(source, file), join(candidate, file));
    }
    for (const file of config.files) {
      mkdirSync(dirname(join(vendor, file)), { recursive: true });
      cpSync(join(candidate, file), join(vendor, file));
    }
    cpSync(join(source, 'package.json'), join(vendor, 'upstream-package.json'));
    const manifest = readJson(join(vendor, 'package.json'));
    writeJson(join(vendor, 'package.json'), { ...manifest, version: upstream.version });
    for (const [file, before, after] of [
      ['README.md', `Hindsight ${previous.version}`, `Hindsight ${upstream.version}`],
      ['THIRD_PARTY_NOTICES.md', `version ${previous.version},`, `version ${upstream.version},`],
    ]) {
      const path = join(root, file);
      writeFileSync(path, readFileSync(path, 'utf8').replace(before, after));
    }
    return { changed: true, version: upstream.version };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { tarball: { type: 'string' } } });
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = await syncUpstream(root, values);
  console.log(result.changed ? `Updated Hindsight to ${result.version}` : `Hindsight ${result.version} is already current`);
}
