import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import process from 'node:process';

export const PRIVATE_MINIPROGRAM_ROOT = 'miniprogram-private';
export const PRIVATE_PROJECT_CONFIG_PATH = 'project.private.config.json';

const PUBLIC_MINIPROGRAM_ROOT = 'miniprogram';
const STAGING_MINIPROGRAM_ROOT = '.miniprogram-private-staging';
const BACKUP_MINIPROGRAM_ROOT = '.miniprogram-private-backup';
const STAGING_PROJECT_CONFIG_PATH = 'project.private.config.staging.json';
const BACKUP_PROJECT_CONFIG_PATH = 'project.private.config.backup.json';
const CLOUD_ENV_MODULE = 'config/cloud.ts';
const APP_ID_PATTERN = /^wx[a-z0-9]{16}$/;
const ENV_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;

export function preparePrivateMiniprogram(environment) {
  const appId = required(environment, 'MINIPROGRAM_APP_ID');
  const envId = required(environment, 'CLOUDBASE_ENV_ID');
  assert(APP_ID_PATTERN.test(appId), 'MINIPROGRAM_APP_ID 格式无效');
  assert(ENV_ID_PATTERN.test(envId) && !envId.includes('{{'), 'CLOUDBASE_ENV_ID 格式无效');
  ensurePrivatePathsAreSafe();

  const workspace = process.cwd();
  const source = resolve(workspace, PUBLIC_MINIPROGRAM_ROOT);
  const target = resolve(workspace, PRIVATE_MINIPROGRAM_ROOT);
  const staging = resolve(workspace, STAGING_MINIPROGRAM_ROOT);
  const backup = resolve(workspace, BACKUP_MINIPROGRAM_ROOT);
  assertInside(workspace, target);
  assertInside(workspace, staging);
  assertInside(workspace, backup);
  rmSync(staging, { recursive: true, force: true });
  rmSync(backup, { recursive: true, force: true });
  cpSync(source, staging, { recursive: true });
  writeFileSync(resolve(staging, CLOUD_ENV_MODULE), renderPrivateCloudEnvironment(envId), {
    encoding: 'utf8',
    mode: 0o600,
  });

  const existingProjectConfig = existsSync(PRIVATE_PROJECT_CONFIG_PATH)
    ? readJson(PRIVATE_PROJECT_CONFIG_PATH)
    : {};
  const privateProjectConfig = buildPrivateProjectConfig(existingProjectConfig, appId);
  replaceDirectoryAtomically(staging, target, backup);
  writeJsonAtomically(privateProjectConfig);
  validatePreparedMiniprogram(envId, appId);
}

export function buildPrivateProjectConfig(existing, appId) {
  assert(isObject(existing), 'project.private.config.json 必须是对象');
  assert(APP_ID_PATTERN.test(appId), 'MINIPROGRAM_APP_ID 格式无效');
  return {
    ...existing,
    appid: appId,
    miniprogramRoot: `${PRIVATE_MINIPROGRAM_ROOT}/`,
    srcMiniprogramRoot: `${PRIVATE_MINIPROGRAM_ROOT}/`,
  };
}

export function renderPrivateCloudEnvironment(envId) {
  assert(ENV_ID_PATTERN.test(envId) && !envId.includes('{{'), 'CLOUDBASE_ENV_ID 格式无效');
  return `// Generated locally; this directory is ignored by Git.\nexport const cloudEnvironmentId = ${JSON.stringify(envId)};\n`;
}

export function validatePreparedMiniprogram(expectedEnvId, expectedAppId) {
  assert(
    ENV_ID_PATTERN.test(expectedEnvId) && !expectedEnvId.includes('{{'),
    '预期云环境 ID 格式无效',
  );
  ensurePrivatePathsAreSafe();
  const privateProjectConfig = readJson(PRIVATE_PROJECT_CONFIG_PATH);
  assert(
    typeof privateProjectConfig.appid === 'string' &&
      APP_ID_PATTERN.test(privateProjectConfig.appid),
    '本机私有项目配置缺少真实 AppID',
  );
  assert(APP_ID_PATTERN.test(expectedAppId), '预期 AppID 格式无效');
  assert(privateProjectConfig.appid === expectedAppId, '本机私有项目 AppID 与目标不一致');
  assert(privateProjectConfig.appid !== 'touristappid', '本机私有项目配置仍使用游客 AppID');
  assert(
    privateProjectConfig.miniprogramRoot === `${PRIVATE_MINIPROGRAM_ROOT}/` &&
      privateProjectConfig.srcMiniprogramRoot === `${PRIVATE_MINIPROGRAM_ROOT}/`,
    '本机私有项目配置未指向隔离的小程序副本',
  );
  const privateCloudModule = readFileSync(
    resolve(PRIVATE_MINIPROGRAM_ROOT, CLOUD_ENV_MODULE),
    'utf8',
  );
  assert(
    privateCloudModule === renderPrivateCloudEnvironment(expectedEnvId),
    '小程序私有副本与目标云环境不一致，请重新生成',
  );
  const publicCloudModule = readFileSync(
    resolve(PUBLIC_MINIPROGRAM_ROOT, CLOUD_ENV_MODULE),
    'utf8',
  );
  assert(
    /cloudEnvironmentId\s*=\s*''/.test(publicCloudModule),
    '公开小程序源码不得包含真实云环境 ID',
  );
  const appSource = readFileSync(resolve(PRIVATE_MINIPROGRAM_ROOT, 'app.ts'), 'utf8');
  assert(
    appSource.includes('wx.cloud.init({ env: cloudEnvironmentId, traceUser: true })'),
    '小程序入口未显式绑定私有云环境',
  );
  const mirrorDifferences = compareMiniprogramTrees(
    PUBLIC_MINIPROGRAM_ROOT,
    PRIVATE_MINIPROGRAM_ROOT,
    new Set([CLOUD_ENV_MODULE]),
  );
  assert(
    mirrorDifferences.length === 0,
    `私有小程序副本已过期或被修改，请重新生成：${mirrorDifferences.slice(0, 3).join('、')}`,
  );
}

export function compareMiniprogramTrees(publicRoot, privateRoot, ignoredPaths = new Set()) {
  const publicFiles = listFiles(resolve(publicRoot));
  const privateFiles = listFiles(resolve(privateRoot));
  const allPaths = new Set([...publicFiles.keys(), ...privateFiles.keys()]);
  const differences = [];
  for (const path of [...allPaths].sort()) {
    if (ignoredPaths.has(path)) continue;
    const publicPath = publicFiles.get(path);
    const privatePath = privateFiles.get(path);
    if (publicPath === undefined) differences.push(`私有副本多出 ${path}`);
    else if (privatePath === undefined) differences.push(`私有副本缺少 ${path}`);
    else if (!readFileSync(publicPath).equals(readFileSync(privatePath))) {
      differences.push(`内容不一致 ${path}`);
    }
  }
  return differences;
}

function ensurePrivatePathsAreSafe() {
  const paths = [
    [PRIVATE_MINIPROGRAM_ROOT, `${PRIVATE_MINIPROGRAM_ROOT}/config/cloud.ts`],
    [STAGING_MINIPROGRAM_ROOT, `${STAGING_MINIPROGRAM_ROOT}/config/cloud.ts`],
    [BACKUP_MINIPROGRAM_ROOT, `${BACKUP_MINIPROGRAM_ROOT}/config/cloud.ts`],
    [PRIVATE_PROJECT_CONFIG_PATH, PRIVATE_PROJECT_CONFIG_PATH],
    [STAGING_PROJECT_CONFIG_PATH, STAGING_PROJECT_CONFIG_PATH],
    [BACKUP_PROJECT_CONFIG_PATH, BACKUP_PROJECT_CONFIG_PATH],
  ];
  for (const [path, ignoreProbe] of paths) {
    const ignored = spawnSync('git', ['check-ignore', '--quiet', '--', ignoreProbe], {
      stdio: 'ignore',
    });
    assert(ignored.status === 0, `${path} 必须先由 .gitignore 排除`);
    const tracked = spawnSync('git', ['ls-files', '--', path], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert(tracked.status === 0, `无法检查 ${path} 的 Git 状态`);
    assert(tracked.stdout.trim().length === 0, `${path} 已被 Git 跟踪，拒绝写入私有标识`);
  }
}

function replaceDirectoryAtomically(staging, target, backup) {
  let oldMoved = false;
  try {
    if (existsSync(target)) {
      renameSync(target, backup);
      oldMoved = true;
    }
    renameSync(staging, target);
    if (oldMoved) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(target) && oldMoved && existsSync(backup)) renameSync(backup, target);
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function writeJsonAtomically(config) {
  rmSync(STAGING_PROJECT_CONFIG_PATH, { force: true });
  rmSync(BACKUP_PROJECT_CONFIG_PATH, { force: true });
  writeFileSync(STAGING_PROJECT_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  let oldMoved = false;
  try {
    if (existsSync(PRIVATE_PROJECT_CONFIG_PATH)) {
      renameSync(PRIVATE_PROJECT_CONFIG_PATH, BACKUP_PROJECT_CONFIG_PATH);
      oldMoved = true;
    }
    renameSync(STAGING_PROJECT_CONFIG_PATH, PRIVATE_PROJECT_CONFIG_PATH);
    if (oldMoved) rmSync(BACKUP_PROJECT_CONFIG_PATH, { force: true });
  } catch (error) {
    if (
      !existsSync(PRIVATE_PROJECT_CONFIG_PATH) &&
      oldMoved &&
      existsSync(BACKUP_PROJECT_CONFIG_PATH)
    ) {
      renameSync(BACKUP_PROJECT_CONFIG_PATH, PRIVATE_PROJECT_CONFIG_PATH);
    }
    rmSync(STAGING_PROJECT_CONFIG_PATH, { force: true });
    throw error;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取或解析 ${path}`, { cause: error });
  }
}

function listFiles(root) {
  const files = new Map();
  visit(root, '');
  return files;

  function visit(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(absolutePath, relativePath);
      else if (entry.isFile()) files.set(relativePath, absolutePath);
      else throw new Error(`小程序目录包含不受支持的文件类型：${relativePath}`);
    }
  }
}

function required(environment, key) {
  const value = environment[key];
  assert(typeof value === 'string' && value.length > 0, `缺少本机环境变量 ${key}`);
  assert(value === value.trim() && !/[\0\r\n]/.test(value), `${key} 格式无效`);
  return value;
}

function assertInside(parent, child) {
  const relationship = relative(parent, child);
  assert(
    relationship.length > 0 &&
      relationship !== '..' &&
      !relationship.startsWith(`..${sep}`) &&
      resolve(parent, relationship) === child,
    '私有小程序目录越界',
  );
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
