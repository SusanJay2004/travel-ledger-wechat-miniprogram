import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const catalog = readJson('config/cloud-database-indexes.json');
const rules = readJson('config/cloud-database-rules.json');
assert(catalog.version === 1, '索引目录版本必须为 1');
assert(Array.isArray(catalog.indexes), '索引目录缺少 indexes');
const sourceQueryAudit = auditSourceQueries();
assert(
  catalog.sourceQueryAudit?.count === sourceQueryAudit.count &&
    catalog.sourceQueryAudit?.sha256 === sourceQueryAudit.sha256,
  `生产查询形态已变化，必须重新审计索引并更新 sourceQueryAudit：${JSON.stringify(sourceQueryAudit)}`,
);

const signatures = new Set();
const indexesByCollection = new Map();
for (const index of catalog.indexes) {
  assert(typeof index.collection === 'string' && index.collection.length > 0, '索引集合名无效');
  assert(typeof index.unique === 'boolean', `${index.collection} 索引缺少 unique`);
  assert(
    Array.isArray(index.fields) && index.fields.length > 0,
    `${index.collection} 索引字段为空`,
  );
  assert(index.fields.length <= 5, `${index.collection} 索引字段超过平台上限`);
  const fieldNames = new Set();
  for (const item of index.fields) {
    assert(
      typeof item.field === 'string' && item.field.length > 0,
      `${index.collection} 字段名无效`,
    );
    assert(
      item.order === 'ASC' || item.order === 'DESC',
      `${index.collection}.${item.field} 排序无效`,
    );
    assert(!fieldNames.has(item.field), `${index.collection} 索引字段重复：${item.field}`);
    fieldNames.add(item.field);
  }
  const signature = indexSignature(index);
  assert(!signatures.has(signature), `索引重复：${signature}`);
  signatures.add(signature);
  const collectionIndexes = indexesByCollection.get(index.collection) ?? [];
  collectionIndexes.push(index);
  indexesByCollection.set(index.collection, collectionIndexes);
}

for (const [collection, indexes] of indexesByCollection) {
  assert(indexes.length <= 20, `${collection} 索引数量超过官方建议上限 20`);
}

const expectedCollections = [
  'users',
  'trips',
  'friend_requests',
  'friendships',
  'blocks',
  'notifications',
  'trip_invitations',
  'sync_events',
  'audit_logs',
  'idempotency_records',
  'rate_limit_records',
  'backup_manifests',
];
assert(
  JSON.stringify([...Object.keys(rules)].sort()) ===
    JSON.stringify([...expectedCollections].sort()),
  '数据库安全规则集合与权威集合清单不一致',
);
for (const collection of expectedCollections) {
  assert(indexesByCollection.has(collection), `${collection} 没有登记任何索引`);
}

for (const required of requiredIndexes()) {
  const available = indexesByCollection.get(required.collection) ?? [];
  assert(
    available.some(
      (index) =>
        index.unique === required.unique &&
        required.fields.every(
          (field, position) =>
            index.fields[position]?.field === field.field &&
            index.fields[position]?.order === field.order,
        ),
    ),
    `缺少查询索引前缀：${indexSignature(required)}`,
  );
}

const docs = readFileSync('docs/cloud-deployment-manifest.md', 'utf8');
const table = betweenMarkers(docs, '<!-- cloud-indexes:start -->', '<!-- cloud-indexes:end -->');
const documentedSignatures = new Set(
  [...table.matchAll(/^\|\s*`([^`]+)`\s*\|\s*(唯一|普通)\s*\|\s*`([^`]+)`\s*\|$/gm)].map(
    ([, collection, type, fields]) =>
      indexSignature({
        collection,
        unique: type === '唯一',
        fields: fields.split(', ').map((fieldWithOrder) => {
          const [field, order] = fieldWithOrder.split(' ');
          return { field, order };
        }),
      }),
  ),
);
assert(documentedSignatures.size === signatures.size, '部署清单索引数量与权威目录不一致');
for (const signature of signatures) {
  assert(documentedSignatures.has(signature), `部署清单未展示索引：${signature}`);
}
for (const signature of documentedSignatures) {
  assert(signatures.has(signature), `部署清单含未登记索引：${signature}`);
}

process.stdout.write(
  `云数据库索引校验通过：${catalog.indexes.length} 个索引覆盖 ${expectedCollections.length} 个集合及 ${sourceQueryAudit.count} 个生产查询调用。\n`,
);

function auditSourceQueries() {
  const roots = ['cloudfunctions', 'miniprogram'];
  const calls = [];
  for (const root of roots) {
    for (const path of productionTypeScriptFiles(root)) {
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      visit(source, source, path, calls);
    }
  }
  calls.sort();
  return {
    count: calls.length,
    sha256: createHash('sha256').update(calls.join('\n')).digest('hex'),
  };
}

function productionTypeScriptFiles(root) {
  const result = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'node_modules') continue;
      result.push(...productionTypeScriptFiles(path));
      continue;
    }
    if (extname(entry.name) === '.ts' && !entry.name.endsWith('.test.ts')) result.push(path);
  }
  return result;
}

function visit(node, source, path, calls) {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    (node.expression.name.text === 'where' || node.expression.name.text === 'orderBy')
  ) {
    const call = source.text.slice(node.getStart(source), node.getEnd()).replace(/\s+/g, ' ');
    calls.push(`${relative(process.cwd(), path).replaceAll('\\', '/')}:${call}`);
  }
  ts.forEachChild(node, (child) => visit(child, source, path, calls));
}

function requiredIndexes() {
  return [
    required('users', true, 'openId'),
    required('users', true, 'publicId'),
    required('users', false, 'qrSceneToken'),
    required('users', false, 'pendingAvatarReviewId'),
    required('users', false, 'pendingAvatarExpiresAt', '_id'),
    required('users', false, 'stagedAvatarExpiresAt', '_id'),
    required('users', false, 'status', '_id'),
    required('trips', false, 'memberIds', '_id'),
    required('friend_requests', true, 'pendingKey'),
    required('friend_requests', false, 'fromUserId', 'toUserId', 'status'),
    required('friend_requests', false, 'toUserId'),
    required('friend_requests', false, 'expiresAt'),
    required('friendships', false, 'userIds'),
    required('blocks', false, 'blockerUserId', 'blockedUserId'),
    required('blocks', false, 'blockedUserId'),
    required('notifications', false, 'userId'),
    required('notifications', false, 'actorUserId'),
    required('notifications', false, 'tripId'),
    required('notifications', false, 'requestId'),
    required('notifications', false, 'invitationId'),
    required('trip_invitations', true, 'pendingKey'),
    required('trip_invitations', false, 'tripId', 'inviteeUserId', 'status'),
    required('trip_invitations', false, 'inviterUserId'),
    required('trip_invitations', false, 'inviteeUserId'),
    required('trip_invitations', false, 'expiresAt'),
    required('sync_events', false, 'userId', 'tripId'),
    required('sync_events', false, 'tripId'),
    required('sync_events', false, 'createdAt'),
    required('audit_logs', false, 'tripId'),
    required('audit_logs', false, 'createdAt'),
    required('idempotency_records', false, 'expiresAt'),
    required('rate_limit_records', false, 'expiresAt'),
    required('backup_manifests', false, 'createdAt', undefined, 'DESC'),
    required('backup_manifests', false, 'expiresAt'),
  ];
}

function required(collection, unique, ...fieldNames) {
  const last = fieldNames.at(-1);
  const explicitOrder = last === 'DESC' ? fieldNames.pop() : 'ASC';
  return {
    collection,
    unique,
    fields: fieldNames
      .filter((field) => typeof field === 'string')
      .map((field) => ({ field, order: explicitOrder })),
  };
}

function indexSignature(index) {
  return `${index.collection}:${index.unique ? 'unique' : 'normal'}:${index.fields
    .map((item) => `${item.field}:${item.order}`)
    .join(',')}`;
}

function betweenMarkers(value, startMarker, endMarker) {
  const start = value.indexOf(startMarker);
  const end = value.indexOf(endMarker);
  assert(start >= 0 && end > start, '部署清单缺少索引表边界标记');
  return value.slice(start + startMarker.length, end);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
