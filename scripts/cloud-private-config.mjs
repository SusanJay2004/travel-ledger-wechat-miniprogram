import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  preparePrivateMiniprogram,
  validatePreparedMiniprogram,
} from './miniprogram-private-config.mjs';

export const PRIVATE_CONFIG_PATH = 'cloudbaserc.private.json';
export const PUBLIC_CONFIG_PATH = 'cloudbaserc.json';

const ENV_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const PRODUCT_MODES = new Set(['solo', 'collaboration']);
const DEPLOYMENT_STAGES = new Set(['development', 'production']);
const MINIPROGRAM_ENV_VERSIONS = new Set(['develop', 'trial', 'release']);
const COLLABORATION_ACK = 'I_HAVE_PLATFORM_APPROVAL';
const PRODUCTION_ACK = 'PRODUCTION_ENV_REVIEWED';

export function buildPrivateCloudConfig(publicConfig, environment) {
  validatePublicTemplate(publicConfig);
  const envId = required(environment, 'CLOUDBASE_ENV_ID');
  const productMode = required(environment, 'PRODUCT_MODE');
  const deploymentStage = required(environment, 'CLOUD_DEPLOYMENT_STAGE');
  const miniprogramEnvVersion = required(environment, 'MINIPROGRAM_ENV_VERSION');
  const contentSecurityMode = optional(environment, 'CONTENT_SECURITY_MODE');

  assert(ENV_ID_PATTERN.test(envId), 'CLOUDBASE_ENV_ID 格式无效');
  assert(!envId.includes('{{'), 'CLOUDBASE_ENV_ID 不能是模板占位符');
  assert(PRODUCT_MODES.has(productMode), 'PRODUCT_MODE 必须是 solo 或 collaboration');
  assert(
    DEPLOYMENT_STAGES.has(deploymentStage),
    'CLOUD_DEPLOYMENT_STAGE 必须是 development 或 production',
  );
  assert(
    MINIPROGRAM_ENV_VERSIONS.has(miniprogramEnvVersion),
    'MINIPROGRAM_ENV_VERSION 必须是 develop、trial 或 release',
  );
  assert(
    contentSecurityMode === undefined || contentSecurityMode === 'disabled',
    'CONTENT_SECURITY_MODE 只能省略或设为 disabled',
  );
  assert(
    contentSecurityMode !== 'disabled' ||
      (deploymentStage === 'development' && miniprogramEnvVersion === 'develop'),
    '只有开发云环境配合 develop 小程序版本时才允许禁用内容安全',
  );
  assert(
    deploymentStage !== 'development' || miniprogramEnvVersion === 'develop',
    '开发云环境只能绑定 develop 小程序版本',
  );
  assert(
    deploymentStage !== 'production' || miniprogramEnvVersion !== 'develop',
    '生产云环境不得绑定 develop 小程序版本',
  );
  assert(
    productMode !== 'collaboration' ||
      optional(environment, 'ALLOW_COLLABORATION_DEPLOY') === COLLABORATION_ACK,
    `协作模式必须显式设置 ALLOW_COLLABORATION_DEPLOY=${COLLABORATION_ACK}`,
  );
  assert(
    deploymentStage !== 'production' ||
      optional(environment, 'ALLOW_PRODUCTION_DEPLOY') === PRODUCTION_ACK,
    `生产环境必须显式设置 ALLOW_PRODUCTION_DEPLOY=${PRODUCTION_ACK}`,
  );

  const privateConfig = cloneJson(publicConfig);
  privateConfig.envId = envId;
  for (const fn of privateConfig.functions) fn.envVariables = {};
  const apiFunction = privateConfig.functions.find((item) => item.name === 'api');
  assert(apiFunction !== undefined, '公开部署模板缺少 api 函数');
  apiFunction.envVariables = {
    CLOUD_DEPLOYMENT_STAGE: deploymentStage,
    MINIPROGRAM_ENV_VERSION: miniprogramEnvVersion,
    PRODUCT_MODE: productMode,
    ...(contentSecurityMode === undefined ? {} : { CONTENT_SECURITY_MODE: contentSecurityMode }),
  };

  validatePrivateCloudConfig(privateConfig, publicConfig);
  return privateConfig;
}

export function validatePrivateCloudConfig(privateConfig, publicConfig) {
  validatePublicTemplate(publicConfig);
  assert(isObject(privateConfig), '私有部署配置必须是对象');
  assert(
    typeof privateConfig.envId === 'string' && ENV_ID_PATTERN.test(privateConfig.envId),
    '私有部署配置缺少有效环境 ID',
  );
  assert(!privateConfig.envId.includes('{{'), '私有部署配置仍含环境 ID 占位符');
  assert(
    Array.isArray(privateConfig.functions) &&
      privateConfig.functions.length === publicConfig.functions.length,
    '私有部署配置的云函数数量与公开模板不一致',
  );

  const sanitized = cloneJson(privateConfig);
  sanitized.envId = publicConfig.envId;
  const apiFunction = sanitized.functions.find((item) => item.name === 'api');
  assert(apiFunction !== undefined, '私有部署配置缺少 api 函数');
  const envVariables = apiFunction.envVariables;
  assert(isObject(envVariables), 'api 私有部署配置缺少环境变量');

  const productMode = envVariables.PRODUCT_MODE;
  const deploymentStage = envVariables.CLOUD_DEPLOYMENT_STAGE;
  const miniprogramEnvVersion = envVariables.MINIPROGRAM_ENV_VERSION;
  const contentSecurityMode = envVariables.CONTENT_SECURITY_MODE;
  assert(PRODUCT_MODES.has(productMode), 'api.PRODUCT_MODE 无效');
  assert(DEPLOYMENT_STAGES.has(deploymentStage), 'api.CLOUD_DEPLOYMENT_STAGE 无效');
  assert(MINIPROGRAM_ENV_VERSIONS.has(miniprogramEnvVersion), 'api.MINIPROGRAM_ENV_VERSION 无效');
  assert(
    contentSecurityMode === undefined || contentSecurityMode === 'disabled',
    'api.CONTENT_SECURITY_MODE 无效',
  );
  assert(
    contentSecurityMode !== 'disabled' ||
      (deploymentStage === 'development' && miniprogramEnvVersion === 'develop'),
    '私有配置只允许在 development/develop 组合中禁用内容安全',
  );
  assert(
    deploymentStage !== 'development' || miniprogramEnvVersion === 'develop',
    '私有配置禁止开发云环境绑定非 develop 小程序版本',
  );
  assert(
    deploymentStage !== 'production' || miniprogramEnvVersion !== 'develop',
    '私有配置禁止生产云环境绑定 develop 小程序版本',
  );

  const allowedKeys = new Set([
    'CLOUD_DEPLOYMENT_STAGE',
    'CONTENT_SECURITY_MODE',
    'MINIPROGRAM_ENV_VERSION',
    'PRODUCT_MODE',
  ]);
  for (const key of Object.keys(envVariables)) {
    assert(allowedKeys.has(key), `api 存在未审核的环境变量：${key}`);
  }
  for (const fn of sanitized.functions) {
    assert(isObject(fn.envVariables), `${fn.name} 必须显式声明完整环境变量集合`);
    if (fn.name !== 'api') {
      assert(Object.keys(fn.envVariables).length === 0, `${fn.name} 不得设置运行环境变量`);
    }
    delete fn.envVariables;
  }

  assert(
    deepEqual(sanitized, publicConfig),
    '私有部署配置除环境 ID 和已审核 api 环境变量外不得偏离公开模板',
  );
  return {
    deploymentStage,
    miniprogramEnvVersion,
    productMode,
    contentSecurityDisabled: contentSecurityMode === 'disabled',
  };
}

export function ensurePrivateConfigPathIsSafe(path = PRIVATE_CONFIG_PATH) {
  const absolute = resolve(path);
  assert(absolute === resolve(PRIVATE_CONFIG_PATH), '私有部署配置只能写入仓库根目录固定路径');
  const ignored = spawnSync('git', ['check-ignore', '--quiet', '--', path], { stdio: 'ignore' });
  assert(ignored.status === 0, `${path} 必须先由 .gitignore 排除`);
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', path], {
    stdio: 'ignore',
  });
  assert(tracked.status !== 0, `${path} 已被 Git 跟踪，拒绝写入真实环境 ID`);
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取或解析 ${path}`, { cause: error });
  }
}

function validatePublicTemplate(config) {
  assert(isObject(config), '公开部署模板必须是对象');
  assert(config.envId === '{{env.CLOUDBASE_ENV_ID}}', '公开模板必须保留环境 ID 占位符');
  assert(Array.isArray(config.functions), '公开模板缺少 functions');
  assert(config.functions.length === 4, '公开模板必须恰好声明四个云函数');
  const names = config.functions.map((item) => item.name).sort();
  assert(
    deepEqual(names, ['api', 'avatar-review', 'backup', 'maintenance']),
    '公开模板的云函数集合不正确',
  );
  for (const fn of config.functions) {
    assert(fn.envVariables === undefined, `${fn.name} 的公开模板不得写入部署环境变量`);
  }
}

function required(environment, key) {
  const value = optional(environment, key);
  assert(value !== undefined, `缺少本机环境变量 ${key}`);
  return value;
}

function optional(environment, key) {
  const value = environment[key];
  if (value === undefined) return undefined;
  assert(typeof value === 'string', `${key} 必须是字符串`);
  assert(value.length > 0 && value === value.trim(), `${key} 不能为空或包含首尾空白`);
  assert(!/[\0\r\n]/.test(value), `${key} 不能包含控制字符`);
  return value;
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runCli() {
  const command = process.argv[2] ?? 'check';
  ensurePrivateConfigPathIsSafe();
  const publicConfig = readJson(PUBLIC_CONFIG_PATH);
  if (command === 'prepare') {
    const privateConfig = buildPrivateCloudConfig(publicConfig, process.env);
    preparePrivateMiniprogram(process.env);
    writeFileSync(PRIVATE_CONFIG_PATH, `${JSON.stringify(privateConfig, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } else if (command !== 'check') {
    throw new Error('用法：node scripts/cloud-private-config.mjs prepare|check');
  }
  const privateConfig = readJson(PRIVATE_CONFIG_PATH);
  const profile = validatePrivateCloudConfig(privateConfig, publicConfig);
  validatePreparedMiniprogram(privateConfig.envId, required(process.env, 'MINIPROGRAM_APP_ID'));
  process.stdout.write(
    `私有云部署配置校验通过：${profile.deploymentStage}/${profile.productMode}/${profile.miniprogramEnvVersion}，内容安全${profile.contentSecurityDisabled ? '仅开发环境临时禁用' : '失败关闭'}；环境 ID 已脱敏。\n`,
  );
}

const invokedPath =
  process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
