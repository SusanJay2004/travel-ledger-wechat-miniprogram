import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  PRIVATE_CONFIG_PATH,
  PUBLIC_CONFIG_PATH,
  ensurePrivateConfigPathIsSafe,
  readJson,
  validatePrivateCloudConfig,
} from './cloud-private-config.mjs';
import { validatePreparedMiniprogram } from './miniprogram-private-config.mjs';

const DEPLOY_ACK = 'DEPLOY_REVIEWED_PRIVATE_CONFIG';
const COLLABORATION_ACK = 'I_HAVE_PLATFORM_APPROVAL';
const PRODUCTION_ACK = 'PRODUCTION_ENV_REVIEWED';

function runDeployment() {
  ensurePrivateConfigPathIsSafe();
  const privateConfig = readJson(PRIVATE_CONFIG_PATH);
  const profile = validatePrivateCloudConfig(privateConfig, readJson(PUBLIC_CONFIG_PATH));
  validatePreparedMiniprogram(privateConfig.envId, requiredEnvironment('MINIPROGRAM_APP_ID'));
  assert(
    process.env['CONFIRM_CLOUD_DEPLOY'] === DEPLOY_ACK,
    `部署前必须显式设置 CONFIRM_CLOUD_DEPLOY=${DEPLOY_ACK}`,
  );
  assert(
    profile.productMode !== 'collaboration' ||
      process.env['ALLOW_COLLABORATION_DEPLOY'] === COLLABORATION_ACK,
    `协作模式部署必须再次设置 ALLOW_COLLABORATION_DEPLOY=${COLLABORATION_ACK}`,
  );
  assert(
    profile.deploymentStage !== 'production' ||
      process.env['ALLOW_PRODUCTION_DEPLOY'] === PRODUCTION_ACK,
    `生产部署必须再次设置 ALLOW_PRODUCTION_DEPLOY=${PRODUCTION_ACK}`,
  );
  assertCleanWorktree();

  runNpm(['ci'], privateConfig.envId);
  runNpm(['run', 'check'], privateConfig.envId);
  runNpm(['run', 'build'], privateConfig.envId);
  runNpm(['run', 'cloud:smoke-packages'], privateConfig.envId);
  runNpm(['audit', '--audit-level=critical'], privateConfig.envId);
  run('git', ['diff', '--check'], privateConfig.envId);

  const tcbPrefix = [
    'exec',
    '--yes',
    '--package',
    '@cloudbase/cli@3.6.3',
    '--',
    'tcb',
    '--config-file',
    resolve(PRIVATE_CONFIG_PATH),
  ];
  runNpm([...tcbPrefix, 'fn', 'deploy', '--all'], privateConfig.envId);
  const diffOutput = captureNpm(
    [...tcbPrefix, 'config', 'diff', 'fn', '--all', '--json'],
    privateConfig.envId,
  );
  const diffResults = parseCloudConfigDiff(diffOutput);
  const expectedFunctions = new Set(['api', 'avatar-review', 'maintenance', 'backup']);
  assert(diffResults.length === expectedFunctions.size, '云端配置差异结果数量不正确');
  for (const result of diffResults) {
    assert(isObject(result) && typeof result.name === 'string', '云端配置差异结果格式无效');
    assert(expectedFunctions.delete(result.name), `云端配置差异包含未知或重复函数：${result.name}`);
    assert(
      result.status === 'unchanged' && result.hasChanges === false,
      `云端函数配置仍有差异：${result.name} (${String(result.status)})`,
    );
  }
  assert(expectedFunctions.size === 0, '云端配置差异结果缺少函数');
  process.stdout.write(
    '四个云函数已部署，且公开规格、私有运行变量与真实云端配置一致；仍须按部署清单读取函数详情、核对规则/索引并完成烟测。\n',
  );
}

function assertCleanWorktree() {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    encoding: 'utf8',
  });
  assert(result.status === 0, '无法读取 Git 工作区状态');
  assert(result.stdout.trim().length === 0, '部署前 Git 工作区必须干净');
}

function runNpm(args, envId) {
  const npmCli = process.env['npm_execpath'];
  assert(typeof npmCli === 'string' && npmCli.length > 0, '请通过 npm run cloud:deploy 执行');
  run(process.execPath, [npmCli, ...args], envId);
}

function captureNpm(args, envId) {
  const npmCli = process.env['npm_execpath'];
  assert(typeof npmCli === 'string' && npmCli.length > 0, '请通过 npm run cloud:deploy 执行');
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.status !== 0) {
    const diagnostic = redact(result.stderr, envId).slice(0, 2_000);
    if (diagnostic.length > 0) process.stderr.write(diagnostic);
    throw new Error('无法读取云端函数配置差异');
  }
  return redact(result.stdout, envId);
}

function run(command, args, envId) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe' });
  const stdout = redact(result.stdout, envId);
  const stderr = redact(result.stderr, envId);
  if (stdout.length > 0) process.stdout.write(stdout);
  if (stderr.length > 0) process.stderr.write(stderr);
  assert(result.status === 0, `命令执行失败：${command} ${redact(args.join(' '), envId)}`);
}

function redact(value, envId) {
  if (typeof value !== 'string') return '';
  return value.replaceAll(envId, '<private-environment-id>');
}

export function parseCloudConfigDiff(output) {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  assert(start >= 0 && end > start, 'CloudBase CLI 未返回 JSON 差异数组');
  let parsed;
  try {
    parsed = JSON.parse(output.slice(start, end + 1));
  } catch {
    throw new Error('CloudBase CLI 返回的配置差异不是有效 JSON');
  }
  assert(Array.isArray(parsed), 'CloudBase CLI 配置差异必须是数组');
  return parsed;
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requiredEnvironment(key) {
  const value = process.env[key];
  assert(typeof value === 'string' && value.length > 0, `缺少本机环境变量 ${key}`);
  return value;
}

const invokedPath =
  process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    runDeployment();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
