import { gzipSync } from 'node:zlib';

import {
  BACKUP_COLLECTIONS,
  appendBackupProgress,
  backupPrefix,
  expiresAt,
  pagePath,
} from './backup';

interface QueryResult<T> {
  data: T[];
}

interface Collection<T> {
  add(options: { data: T }): Promise<unknown>;
  doc(id: string): {
    set(options: { data: T }): Promise<unknown>;
  };
  get(): Promise<QueryResult<T>>;
  limit(value: number): Collection<T>;
  skip(value: number): Collection<T>;
  where(query: Record<string, unknown>): Collection<T>;
  remove(): Promise<{ stats?: { removed?: number } }>;
}

interface Database {
  collection<T>(name: string): Collection<T>;
  command: { lt(value: string): unknown };
}

interface CloudSdk {
  DYNAMIC_CURRENT_ENV: symbol;
  database(): Database;
  deleteFile(options: { fileList: string[] }): Promise<unknown>;
  getWXContext(): { OPENID?: string };
  init(options: { env: symbol }): void;
  uploadFile(options: { cloudPath: string; fileContent: Buffer }): Promise<{ fileID: string }>;
}

interface BackupManifest {
  _id: string;
  id: string;
  status: 'running' | 'completed' | 'failed';
  prefix: string;
  collections: Readonly<Record<string, { documents: number; pages: number }>>;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string;
  errorCode: string | null;
  fileIds: readonly string[];
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cloud = require('wx-server-sdk') as CloudSdk;
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

export async function main(): Promise<BackupManifest> {
  const callerOpenId = cloud.getWXContext().OPENID;
  if (callerOpenId !== undefined && callerOpenId.length > 0) {
    throw new Error('backup function only accepts trusted trigger events');
  }
  const db = cloud.database();
  const now = new Date();
  const backupId = `bak_${now.getTime().toString(36)}`;
  const prefix = backupPrefix(now, backupId);
  const manifest: BackupManifest = {
    _id: backupId,
    id: backupId,
    status: 'running',
    prefix,
    collections: {},
    createdAt: now.toISOString(),
    completedAt: null,
    expiresAt: expiresAt(now),
    errorCode: null,
    fileIds: [],
  };
  const manifests = db.collection<BackupManifest>('backup_manifests');
  await purgeExpiredBackups(db, now.toISOString());
  await manifests.add({ data: manifest });

  let progress = { collections: {}, fileIds: [] } as {
    collections: Record<string, { documents: number; pages: number }>;
    fileIds: string[];
  };
  try {
    for (const collectionName of BACKUP_COLLECTIONS) {
      await backupCollection(db, collectionName, prefix, async (fileId, summary) => {
        progress = appendBackupProgress(
          progress,
          collectionName,
          [fileId],
          summary,
        ) as typeof progress;
        await manifests.doc(backupId).set({
          data: { ...manifest, collections: progress.collections, fileIds: progress.fileIds },
        });
      });
    }
    const completed: BackupManifest = {
      ...manifest,
      status: 'completed',
      collections: progress.collections,
      fileIds: progress.fileIds,
      completedAt: new Date().toISOString(),
    };
    const manifestFileId = await writeManifestFile(completed);
    const persisted = { ...completed, fileIds: [...completed.fileIds, manifestFileId] };
    await manifests.doc(backupId).set({ data: persisted });
    console.info('backup-complete', {
      backupId,
      collections: Object.keys(progress.collections).length,
      documents: Object.values(progress.collections).reduce((sum, item) => sum + item.documents, 0),
    });
    return persisted;
  } catch (error: unknown) {
    const failed: BackupManifest = {
      ...manifest,
      status: 'failed',
      collections: progress.collections,
      fileIds: progress.fileIds,
      completedAt: new Date().toISOString(),
      errorCode: errorCode(error),
    };
    await manifests
      .doc(backupId)
      .set({ data: failed })
      .catch(() => undefined);
    const failedManifestFileId = await writeManifestFile(failed).catch(() => null);
    if (failedManifestFileId !== null) {
      await manifests
        .doc(backupId)
        .set({ data: { ...failed, fileIds: [...failed.fileIds, failedManifestFileId] } })
        .catch(() => undefined);
    }
    console.error('backup-failed', { backupId, errorCode: failed.errorCode });
    throw error;
  }
}

async function purgeExpiredBackups(db: Database, nowIso: string): Promise<void> {
  while (true) {
    const expired = await db
      .collection<BackupManifest>('backup_manifests')
      .where({ expiresAt: db.command.lt(nowIso) })
      .limit(20)
      .get();
    if (expired.data.length === 0) return;
    for (const manifest of expired.data) {
      if (manifest.fileIds.length > 0) {
        await cloud.deleteFile({ fileList: [...manifest.fileIds] });
      }
      await db.collection<BackupManifest>('backup_manifests').where({ _id: manifest.id }).remove();
    }
    if (expired.data.length < 20) return;
  }
}

async function backupCollection(
  db: Database,
  collectionName: string,
  prefix: string,
  onPageUploaded: (fileId: string, summary: { documents: number; pages: number }) => Promise<void>,
): Promise<{
  summary: { documents: number; pages: number };
  fileIds: readonly string[];
}> {
  let documents = 0;
  const fileIds: string[] = [];
  let page = 0;
  while (true) {
    const result = await db
      .collection<Record<string, unknown>>(collectionName)
      .skip(documents)
      .limit(100)
      .get();
    if (result.data.length === 0) break;
    const payload = gzipSync(Buffer.from(JSON.stringify(result.data), 'utf8'));
    const uploaded = await cloud.uploadFile({
      cloudPath: pagePath(prefix, collectionName, page),
      fileContent: payload,
    });
    fileIds.push(uploaded.fileID);
    documents += result.data.length;
    page += 1;
    await onPageUploaded(uploaded.fileID, { documents, pages: page });
    if (result.data.length < 100) break;
  }
  return { summary: { documents, pages: page }, fileIds };
}

async function writeManifestFile(manifest: BackupManifest): Promise<string> {
  const payload = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  const uploaded = await cloud.uploadFile({
    cloudPath: `${manifest.prefix}/manifest.json`,
    fileContent: payload,
  });
  return uploaded.fileID;
}

function errorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'unknown';
  if ('errCode' in error) return String(error.errCode);
  if ('code' in error) return String(error.code);
  return 'unknown';
}
