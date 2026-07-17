import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PRIVATE_CONFIG_PATH,
  PUBLIC_CONFIG_PATH,
  ensurePrivateConfigPathIsSafe,
  readJson,
  validatePrivateCloudConfig,
} from './cloud-private-config.mjs';

const INDEX_CATALOG_PATH = 'config/cloud-database-indexes.json';
const DATABASE_RULES_PATH = 'config/cloud-database-rules.json';
const STORAGE_RULES_PATH = 'config/cloud-storage-rules.json';
const TCB_API_VERSION = '2018-06-08';
const APPLY_ACK = 'APPLY_REVIEWED_INFRASTRUCTURE';
const RULE_REPLACEMENT_ACK = 'REPLACE_REVIEWED_CLIENT_RULES';
const COLLECTION_CREATION_ACK = 'CREATE_REVIEWED_EMPTY_COLLECTIONS';
const COLLABORATION_ACK = 'I_HAVE_PLATFORM_APPROVAL';
const PRODUCTION_ACK = 'PRODUCTION_ENV_REVIEWED';

export function loadInfrastructureManifest(
  catalog = readJson(INDEX_CATALOG_PATH),
  databaseRules = readJson(DATABASE_RULES_PATH),
  storageRule = readJson(STORAGE_RULES_PATH),
) {
  assert(catalog?.version === 1 && Array.isArray(catalog.indexes), '索引目录格式无效');
  assert(isObject(databaseRules), '数据库安全规则模板格式无效');
  assert(isObject(storageRule), '云存储安全规则模板格式无效');

  const collections = Object.keys(databaseRules).sort();
  const collectionSet = new Set(collections);
  const indexes = catalog.indexes.map((index) => normalizeExpectedIndex(index));
  for (const index of indexes) {
    assert(collectionSet.has(index.collection), `索引引用了未声明的集合：${index.collection}`);
  }
  for (const collection of collections) {
    assert(
      indexes.some((index) => index.collection === collection),
      `集合没有登记索引：${collection}`,
    );
    normalizeRule(databaseRules[collection], `数据库规则 ${collection}`);
  }
  normalizeRule(storageRule, '云存储规则');

  return { collections, indexes, databaseRules, storageRule };
}

export function buildInfrastructurePlan(manifest, remoteState) {
  const remoteCollections = remoteState.collections ?? {};
  const expectedCollections = new Set(manifest.collections);
  const unknownCollections = Object.keys(remoteCollections)
    .filter((collection) => !expectedCollections.has(collection))
    .sort();
  const missingCollections = manifest.collections.filter(
    (collection) => remoteCollections[collection] === undefined,
  );
  const missingIndexes = [];
  const unknownIndexes = [];

  for (const collection of manifest.collections) {
    const remoteCollection = remoteCollections[collection];
    if (remoteCollection === undefined) continue;
    const indexDiff = diffCollectionIndexes(manifest, collection, remoteCollection.indexes ?? []);
    missingIndexes.push(...indexDiff.missing);
    unknownIndexes.push(...indexDiff.unknown);
  }

  const databaseRuleUpdates = manifest.collections.filter((collection) => {
    if (remoteCollections[collection] === undefined) return false;
    const actual = remoteState.databaseRules?.[collection];
    return !sameCustomRule(actual, manifest.databaseRules[collection]);
  });
  const storageRuleUpdate = !sameCustomRule(remoteState.storageRule, manifest.storageRule);

  return {
    missingCollections,
    missingIndexes,
    databaseRuleUpdates,
    storageRuleUpdate,
    unknownCollections,
    unknownIndexes,
  };
}

export function isInfrastructureConverged(plan) {
  return (
    plan.missingCollections.length === 0 &&
    plan.missingIndexes.length === 0 &&
    plan.databaseRuleUpdates.length === 0 &&
    plan.storageRuleUpdate === false &&
    plan.unknownCollections.length === 0 &&
    plan.unknownIndexes.length === 0
  );
}

export function buildCreateIndex(index) {
  const normalized = normalizeExpectedIndex(index);
  return {
    IndexName: generatedIndexName(normalized),
    MgoKeySchema: {
      MgoIndexKeys: normalized.fields.map((field) => ({
        Name: field.field,
        Direction: field.order === 'ASC' ? '1' : '-1',
      })),
      MgoIsUnique: normalized.unique,
    },
  };
}

export function parseCliJson(output) {
  const escapeCharacter = String.fromCharCode(27);
  const clean = String(output)
    .replaceAll(new RegExp(`${escapeCharacter}\\[[0-9;]*m`, 'g'), '')
    .trim();
  try {
    return unwrapApiResponse(JSON.parse(clean));
  } catch {
    // CloudBase CLI may print a version banner before its JSON payload.
  }
  const starts = Array.from(clean, (character, index) =>
    character === '{' || character === '[' ? index : -1,
  ).filter((index) => index >= 0);
  for (const start of starts) {
    for (let end = clean.length; end > start; end = clean.lastIndexOf('\n', end - 1)) {
      const candidate = clean.slice(start, end).trim();
      try {
        return unwrapApiResponse(JSON.parse(candidate));
      } catch {
        if (end <= 0) break;
      }
    }
  }
  throw new Error('CloudBase CLI 未返回可解析的 JSON');
}

export function redactPrivateValue(value, privateValue) {
  if (typeof value !== 'string') return '';
  if (typeof privateValue !== 'string' || privateValue.length === 0) return value;
  return value.replaceAll(privateValue, '<private-environment-id>');
}

function normalizeExpectedIndex(index) {
  assert(isObject(index), '索引条目格式无效');
  assert(typeof index.collection === 'string' && index.collection.length > 0, '索引集合名无效');
  assert(typeof index.unique === 'boolean', `${index.collection} 索引缺少 unique`);
  assert(
    Array.isArray(index.fields) && index.fields.length > 0,
    `${index.collection} 索引字段为空`,
  );
  return {
    collection: index.collection,
    unique: index.unique,
    fields: index.fields.map((field) => ({
      field: requiredString(field?.field, `${index.collection} 索引字段名无效`),
      order: normalizeDirection(field?.order),
    })),
  };
}

function normalizeRemoteIndex(collection, index) {
  assert(isObject(index), `${collection} 云端索引格式无效`);
  const keys = index.Keys ?? index.keys ?? index.MgoIndexKeys ?? index.mgoIndexKeys;
  assert(Array.isArray(keys) && keys.length > 0, `${collection} 云端索引缺少 Keys`);
  return {
    collection,
    name: String(index.Name ?? index.name ?? index.IndexName ?? index.indexName ?? ''),
    unique: normalizeBoolean(
      index.Unique ?? index.unique ?? index.MgoIsUnique ?? index.mgoIsUnique,
      `${collection} 云端索引 unique 无效`,
    ),
    fields: keys.map((field) => ({
      field: requiredString(
        field?.Name ?? field?.name ?? field?.field,
        `${collection} 云端索引字段名无效`,
      ),
      order: normalizeDirection(field?.Direction ?? field?.direction ?? field?.order),
    })),
  };
}

function normalizeDirection(value) {
  if (value === 1 || value === '1' || String(value).toUpperCase() === 'ASC') return 'ASC';
  if (value === -1 || value === '-1' || String(value).toUpperCase() === 'DESC') return 'DESC';
  throw new Error(`索引排序方向无效：${String(value)}`);
}

function normalizeBoolean(value, message) {
  if (value === true || value === 1 || String(value).toLowerCase() === 'true') return true;
  if (
    value === false ||
    value === 0 ||
    value === undefined ||
    String(value).toLowerCase() === 'false'
  ) {
    return false;
  }
  throw new Error(message);
}

function sameIndex(left, right) {
  return (
    left.collection === right.collection &&
    left.unique === right.unique &&
    JSON.stringify(left.fields) === JSON.stringify(right.fields)
  );
}

function isBuiltInIdIndex(index) {
  return (
    index.fields.length === 1 &&
    index.fields[0]?.field === '_id' &&
    index.fields[0]?.order === 'ASC' &&
    (index.unique === true || index.name === '_id_')
  );
}

function generatedIndexName(index) {
  const signature = indexSignature(index);
  const fieldPart = index.fields
    .map((field) => `${field.field}_${field.order === 'ASC' ? 'a' : 'd'}`)
    .join('_')
    .replaceAll(/[^A-Za-z0-9_]/g, '_')
    .slice(0, 38);
  const digest = createHash('sha256').update(signature).digest('hex').slice(0, 10);
  return `tl_${fieldPart}_${index.unique ? 'u' : 'n'}_${digest}`;
}

function indexSignature(index) {
  return `${index.collection}:${index.unique ? 'unique' : 'normal'}:${index.fields
    .map((field) => `${field.field}:${field.order}`)
    .join(',')}`;
}

function normalizeRule(value, label) {
  let rule = value;
  if (typeof rule === 'string') {
    try {
      rule = JSON.parse(rule);
    } catch {
      throw new Error(`${label} 不是有效 JSON`);
    }
  }
  assert(isObject(rule), `${label} 必须是 JSON 对象`);
  assert(Object.hasOwn(rule, 'read') && Object.hasOwn(rule, 'write'), `${label} 缺少 read/write`);
  return rule;
}

function sameCustomRule(remote, expected) {
  if (!isObject(remote)) return false;
  const acl = remote.acl ?? remote.AclTag ?? remote.aclTag;
  if (acl !== 'CUSTOM') return false;
  let actualRule = remote.rule ?? remote.Rule;
  try {
    actualRule = normalizeRule(actualRule, '云端安全规则');
  } catch {
    return false;
  }
  return stableJson(actualRule) === stableJson(normalizeRule(expected, '本地安全规则'));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function unwrapApiResponse(value) {
  if (isObject(value) && isObject(value.Response)) return value.Response;
  return value;
}

function runCli() {
  const command = process.argv[2] ?? 'check';
  assert(
    command === 'check' || command === 'apply',
    '用法：npm run cloud:infra:check|cloud:infra:apply',
  );
  ensurePrivateConfigPathIsSafe();
  const privateConfig = readJson(PRIVATE_CONFIG_PATH);
  const profile = validatePrivateCloudConfig(privateConfig, readJson(PUBLIC_CONFIG_PATH));
  const manifest = loadInfrastructureManifest();

  if (command === 'apply') {
    assertApplyAuthorized(profile);
    assertCleanWorktree();
    runLocalGates(privateConfig.envId);
    assertCleanWorktree();
  }

  let remote = loadRemoteState(privateConfig.envId, manifest);
  let plan = buildInfrastructurePlan(manifest, remote);
  printPlan(plan);

  if (command === 'check') {
    assert(isInfrastructureConverged(plan), '真实云基础设施存在漂移；未执行任何写操作');
    process.stdout.write(
      `真实云基础设施只读核验通过：${manifest.collections.length} 个集合、${manifest.indexes.length} 个索引及数据库/存储规则均一致。\n`,
    );
    return;
  }

  assert(
    plan.unknownCollections.length === 0 && plan.unknownIndexes.length === 0,
    '发现未登记集合或索引；为避免覆盖用户数据，已在任何写操作前停止，请先人工审查',
  );
  assertPlanApplyAuthorized(plan);

  for (const collection of plan.missingCollections) {
    callTcbApi(privateConfig.envId, 'CreateTable', {
      EnvId: privateConfig.envId,
      TableName: collection,
    });
    callTcbApi(privateConfig.envId, 'ModifySafeRule', {
      EnvId: privateConfig.envId,
      CollectionName: collection,
      AclTag: 'CUSTOM',
      Rule: JSON.stringify(manifest.databaseRules[collection]),
    });
    process.stdout.write(`已创建缺失集合并立即设置客户端规则：${collection}\n`);
  }

  remote = loadRemoteState(privateConfig.envId, manifest);
  plan = buildInfrastructurePlan(manifest, remote);
  assert(
    plan.unknownCollections.length === 0 && plan.unknownIndexes.length === 0,
    '集合创建后发现未登记资源，停止后续写操作',
  );

  for (const index of plan.missingIndexes) {
    const table = callTcbApi(privateConfig.envId, 'DescribeTable', {
      EnvId: privateConfig.envId,
      TableName: index.collection,
    });
    assert(Array.isArray(table.Indexes), `DescribeTable 未返回 ${index.collection} 的索引数组`);
    const currentDiff = diffCollectionIndexes(manifest, index.collection, table.Indexes);
    assert(
      currentDiff.unknown.length === 0,
      `${index.collection} 在索引写入前出现未登记索引；停止以避免覆盖并发改动`,
    );
    if (!currentDiff.missing.some((missing) => sameIndex(missing, index))) continue;
    const createIndex = buildCreateIndex(index);
    assert(
      !currentDiff.actual.some(
        (actual) => actual.name === createIndex.IndexName && !sameIndex(actual, index),
      ),
      `${index.collection} 的确定性索引名已被不同结构占用；停止以避免平台先删后建`,
    );
    callTcbApi(privateConfig.envId, 'UpdateTable', {
      EnvId: privateConfig.envId,
      TableName: index.collection,
      CreateIndexes: [createIndex],
    });
    process.stdout.write(`已为 ${index.collection} 增量提交 1 个缺失索引；未发送删除请求。\n`);
  }

  for (const collection of plan.databaseRuleUpdates) {
    const currentRule = callTcbApi(privateConfig.envId, 'DescribeSafeRule', {
      EnvId: privateConfig.envId,
      CollectionName: collection,
    });
    const currentRuleState = { acl: currentRule.AclTag, rule: currentRule.Rule };
    assert(
      sameRemoteRuleState(currentRuleState, remote.databaseRules[collection]),
      `${collection} 的数据库规则在计划后发生变化；停止以避免覆盖并发改动`,
    );
    callTcbApi(privateConfig.envId, 'ModifySafeRule', {
      EnvId: privateConfig.envId,
      CollectionName: collection,
      AclTag: 'CUSTOM',
      Rule: JSON.stringify(manifest.databaseRules[collection]),
    });
    process.stdout.write(`已完整更新数据库客户端规则：${collection}\n`);
  }
  if (plan.storageRuleUpdate) {
    const currentStorage = readStorageRule(privateConfig.envId);
    assert(
      sameRemoteRuleState(currentStorage, remote.storageRule),
      '云存储规则在计划后发生变化；停止以避免覆盖并发改动',
    );
    runTcbCommand(
      privateConfig.envId,
      [
        'storage',
        'rules',
        'update',
        '--acl',
        'CUSTOM',
        '--rule',
        JSON.stringify(manifest.storageRule),
        '--json',
      ],
      '更新云存储客户端规则',
    );
    process.stdout.write('已完整更新云存储客户端规则。\n');
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    remote = loadRemoteState(privateConfig.envId, manifest);
    plan = buildInfrastructurePlan(manifest, remote);
    if (isInfrastructureConverged(plan)) {
      process.stdout.write(
        `真实云基础设施应用并回读核验通过：${manifest.collections.length} 个集合、${manifest.indexes.length} 个索引及数据库/存储规则均一致；未删除任何未知资源。\n`,
      );
      return;
    }
    if (plan.unknownCollections.length > 0 || plan.unknownIndexes.length > 0) break;
    synchronousDelay(3_000);
  }
  printPlan(plan);
  throw new Error('真实云基础设施写入后的回读核验未收敛；不得继续部署或声称完成');
}

function loadRemoteState(envId, manifest) {
  const collections = {};
  let offset = 0;
  const limit = 100;
  let total = Number.POSITIVE_INFINITY;
  while (offset < total) {
    const response = callTcbApi(envId, 'ListTables', {
      EnvId: envId,
      MgoOffset: offset,
      MgoLimit: limit,
    });
    const tables = response.Tables ?? response.Collections ?? [];
    assert(tables === null || Array.isArray(tables), 'ListTables 返回格式无效');
    const page = tables ?? [];
    for (const table of page) {
      const name = table?.TableName ?? table?.CollectionName;
      assert(typeof name === 'string' && name.length > 0, 'ListTables 返回了无效集合名');
      collections[name] = { indexes: [] };
    }
    total = Number(response.Pager?.Total ?? response.Total ?? page.length);
    assert(Number.isSafeInteger(total) && total >= 0 && total <= 10_000, 'ListTables 分页总数无效');
    offset += page.length;
    assert(page.length > 0 || offset >= total, 'ListTables 在到达总数前返回空页');
  }
  assert(Object.keys(collections).length === total, 'ListTables 返回了重复或缺失集合');

  const databaseRules = {};
  for (const collection of manifest.collections) {
    if (collections[collection] === undefined) continue;
    const table = callTcbApi(envId, 'DescribeTable', {
      EnvId: envId,
      TableName: collection,
    });
    assert(Array.isArray(table.Indexes), `DescribeTable 未返回 ${collection} 的索引数组`);
    collections[collection].indexes = table.Indexes;
    const rule = callTcbApi(envId, 'DescribeSafeRule', {
      EnvId: envId,
      CollectionName: collection,
    });
    databaseRules[collection] = { acl: rule.AclTag, rule: rule.Rule };
  }

  return {
    collections,
    databaseRules,
    storageRule: readStorageRule(envId),
  };
}

function readStorageRule(envId) {
  const storage = runTcbCommand(
    envId,
    ['storage', 'rules', 'get', '--json'],
    '读取云存储客户端规则',
  );
  return {
    acl: storage.acl ?? storage.AclTag,
    rule: storage.rule ?? storage.Rule,
  };
}

function callTcbApi(envId, action, body) {
  return runTcbCommand(
    envId,
    [
      'api',
      'tcb',
      action,
      '--api-version',
      TCB_API_VERSION,
      '--body',
      JSON.stringify(body),
      '--json',
    ],
    `调用 ${action}`,
  );
}

function runTcbCommand(envId, args, description) {
  const npmCli = process.env['npm_execpath'];
  assert(typeof npmCli === 'string' && npmCli.length > 0, '请通过 npm run 执行云基础设施命令');
  const fullArgs = [
    npmCli,
    'exec',
    '--yes',
    '--package',
    '@cloudbase/cli@3.6.3',
    '--',
    'tcb',
    '--config-file',
    resolve(PRIVATE_CONFIG_PATH),
    '--env-id',
    envId,
    '--yes',
    ...args,
  ];
  const result = spawnSync(process.execPath, fullArgs, { encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) {
    const diagnostic = redactPrivateValue(result.stderr, envId).slice(0, 2_000);
    if (diagnostic.length > 0) process.stderr.write(diagnostic);
    throw new Error(`${description}失败；输出已脱敏`);
  }
  return parseCliJson(redactPrivateValue(result.stdout, envId));
}

export function assertApplyAuthorized(profile, environment = process.env) {
  assert(
    environment['CONFIRM_CLOUD_INFRASTRUCTURE'] === APPLY_ACK,
    `写入前必须设置 CONFIRM_CLOUD_INFRASTRUCTURE=${APPLY_ACK}`,
  );
  assert(
    environment['CONFIRM_RULE_REPLACEMENT'] === RULE_REPLACEMENT_ACK,
    `规则为完整覆盖，必须设置 CONFIRM_RULE_REPLACEMENT=${RULE_REPLACEMENT_ACK}`,
  );
  assert(
    profile.productMode !== 'collaboration' ||
      environment['ALLOW_COLLABORATION_DEPLOY'] === COLLABORATION_ACK,
    `协作模式必须再次设置 ALLOW_COLLABORATION_DEPLOY=${COLLABORATION_ACK}`,
  );
  assert(
    profile.deploymentStage !== 'production' ||
      environment['ALLOW_PRODUCTION_DEPLOY'] === PRODUCTION_ACK,
    `生产环境必须再次设置 ALLOW_PRODUCTION_DEPLOY=${PRODUCTION_ACK}`,
  );
}

export function assertPlanApplyAuthorized(plan, environment = process.env) {
  assert(
    plan.missingCollections.length === 0 ||
      environment['CONFIRM_COLLECTION_CREATION'] === COLLECTION_CREATION_ACK,
    `创建集合后才能设置客户端规则，存在短暂默认权限窗口；必须确认小程序尚未对该环境开放，并设置 CONFIRM_COLLECTION_CREATION=${COLLECTION_CREATION_ACK}`,
  );
}

function assertCleanWorktree() {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    encoding: 'utf8',
  });
  assert(result.status === 0, '无法读取 Git 工作区状态');
  assert(result.stdout.trim().length === 0, '真实云写入前 Git 工作区必须干净');
}

function runLocalGates(envId) {
  runLocalNpm(['ci'], envId);
  runLocalNpm(['run', 'check'], envId);
  runLocalNpm(['run', 'build'], envId);
  runLocalNpm(['run', 'cloud:smoke-packages'], envId);
  runLocalNpm(['audit', '--audit-level=critical'], envId);
  runLocal('git', ['diff', '--check'], envId);
}

function runLocalNpm(args, envId) {
  const npmCli = process.env['npm_execpath'];
  assert(typeof npmCli === 'string' && npmCli.length > 0, '请通过 npm run 执行云基础设施命令');
  runLocal(process.execPath, [npmCli, ...args], envId);
}

function runLocal(command, args, envId) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe' });
  const stdout = redactPrivateValue(result.stdout, envId);
  const stderr = redactPrivateValue(result.stderr, envId);
  if (stdout.length > 0) process.stdout.write(stdout);
  if (stderr.length > 0) process.stderr.write(stderr);
  assert(result.status === 0, `本地门禁命令失败：${command}`);
}

function printPlan(plan) {
  process.stdout.write(
    `云基础设施差异：缺少集合 ${plan.missingCollections.length}，缺少索引 ${plan.missingIndexes.length}，` +
      `数据库规则待更新 ${plan.databaseRuleUpdates.length}，存储规则待更新 ${plan.storageRuleUpdate ? 1 : 0}，` +
      `未登记集合 ${plan.unknownCollections.length}，未登记索引 ${plan.unknownIndexes.length}。\n`,
  );
  if (plan.unknownCollections.length > 0) {
    process.stdout.write(`未登记集合：${plan.unknownCollections.join(', ')}\n`);
  }
  if (plan.unknownIndexes.length > 0) {
    process.stdout.write(
      `未登记索引：${plan.unknownIndexes.map((index) => `${index.collection}/${index.name || '<unnamed>'}`).join(', ')}\n`,
    );
  }
}

function diffCollectionIndexes(manifest, collection, rawIndexes) {
  const actual = rawIndexes.map((index) => normalizeRemoteIndex(collection, index));
  const expected = manifest.indexes.filter((index) => index.collection === collection);
  const unmatched = actual.filter((actualIndex) => !isBuiltInIdIndex(actualIndex));
  const missing = [];
  for (const expectedIndex of expected) {
    const match = unmatched.findIndex((actualIndex) => sameIndex(actualIndex, expectedIndex));
    if (match < 0) missing.push(expectedIndex);
    else unmatched.splice(match, 1);
  }
  return {
    actual,
    missing,
    unknown: unmatched,
  };
}

function sameRemoteRuleState(left, right) {
  if (!isObject(left) || !isObject(right)) return false;
  return canonicalRuleState(left) === canonicalRuleState(right);
}

function canonicalRuleState(value) {
  const acl = value.acl ?? value.AclTag ?? value.aclTag ?? null;
  let rule = value.rule ?? value.Rule ?? null;
  if (typeof rule === 'string') {
    try {
      rule = JSON.parse(rule);
    } catch {
      // Preserve an unparseable rule as text so any later change still fails closed.
    }
  }
  return stableJson({ acl, rule });
}

function synchronousDelay(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function requiredString(value, message) {
  assert(typeof value === 'string' && value.length > 0, message);
  return value;
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
