import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const functions = ['api', 'avatar-review', 'maintenance', 'backup'];
const workspace = process.cwd();
const temporaryRoot = resolve(tmpdir(), `travel-ledger-cloud-smoke-${process.pid}-${Date.now()}`);

assertInside(resolve(tmpdir()), temporaryRoot);
mkdirSync(temporaryRoot, { recursive: false });

try {
  for (const name of functions) {
    const source = resolve(workspace, 'cloudfunctions', name);
    const target = resolve(temporaryRoot, name);
    assertInside(temporaryRoot, target);
    mkdirSync(join(target, 'dist'), { recursive: true });
    for (const file of ['index.js', 'package.json', 'package-lock.json']) {
      cpSync(join(source, file), join(target, file));
    }
    cpSync(join(source, 'dist', 'index.js'), join(target, 'dist', 'index.js'));
    if (existsSync(join(source, 'config.json'))) {
      cpSync(join(source, 'config.json'), join(target, 'config.json'));
    }

    runNpmCi(target);
    runColdLoad(target, name);
    const topLevel = readdirSync(target).sort();
    assert(!topLevel.includes('src'), `${name} 部署包不应包含 src`);
    assert(!topLevel.includes('tsconfig.json'), `${name} 部署包不应包含 tsconfig.json`);
    const bytes = directoryBytes(target);
    process.stdout.write(`${name} 部署包演练通过：${topLevel.join(', ')}（${bytes} bytes）\n`);
  }
} finally {
  assertInside(resolve(tmpdir()), temporaryRoot);
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function runNpmCi(cwd) {
  const npmCli = process.env.npm_execpath;
  if (typeof npmCli !== 'string' || npmCli.length === 0) {
    throw new Error('请通过 npm run cloud:smoke-packages 执行部署包演练');
  }
  run(
    process.execPath,
    [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    cwd,
  );
}

function runColdLoad(cwd, name) {
  run(
    process.execPath,
    [
      '-e',
      "const entry=require('./index.js'); if(typeof entry.main!=='function') throw new Error('main missing')",
    ],
    cwd,
    `${name} 根入口冷加载失败`,
  );
}

function run(command, args, cwd, message = '子进程执行失败') {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) {
    const diagnostic = [result.stdout, result.stderr]
      .filter((value) => typeof value === 'string' && value.trim().length > 0)
      .join('\n')
      .slice(0, 4_000);
    throw new Error(`${message}${diagnostic.length > 0 ? `\n${diagnostic}` : ''}`);
  }
}

function directoryBytes(root) {
  let total = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    total += entry.isDirectory() ? directoryBytes(path) : statSync(path).size;
  }
  return total;
}

function assertInside(parent, child) {
  const relationship = relative(parent, child);
  if (
    relationship.length === 0 ||
    relationship === '..' ||
    relationship.startsWith(`..${sep}`) ||
    resolve(parent, relationship) !== child
  ) {
    throw new Error(`临时路径越界：${basename(child)} 不在 ${basename(parent)} 内`);
  }
  if (dirname(child) === child) throw new Error('拒绝对文件系统根目录操作');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
