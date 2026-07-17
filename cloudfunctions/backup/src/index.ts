import { gzipSync } from 'node:zlib';

import { redactedRuntimeError, safeDiagnosticCode } from '@travel-ledger/domain';

import {
  BACKUP_COLLECTIONS,
  appendBackupProgress,
  backupPrefix,
  expiresAt,
  pagePath,
} from './backup';
import { assertScheduledTrigger, type TriggerContext } from './trigger-auth';
import { deleteFilesCompletely, type DeleteFileResultItem } from './file-deletion';

interface QueryResult<T> {
  data: T[];
}

export interface Collection<T> {
  add(options: { data: T }): Promise<unknown>;
  doc(id: string): {
    set(options: { data: T }): Promise<unknown>;
  };
  get(): Promise<QueryResult<T>>;
  limit(value: number): Collection<T>;
  orderBy(field: string, direction: 'asc' | 'desc'): Collection<T>;
  where(query: Record<string, unknown>): Collection<T>;
  remove(): Promise<{ stats?: { removed?: number } }>;
}

export interface Database {
  collection<T>(name: string): Collection<T>;
  command: { gt(value: string): unknown; lt(value: string): unknown };
}

export interface CloudSdk {
  DYNAMIC_CURRENT_ENV: symbol;
  database(): Database;
  deleteFile(options: { fileList: string[] }): Promise<{
    fileList: readonly DeleteFileResultItem[];
  }>;
  getWXContext(): TriggerContext;
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

let initializedCloud: CloudSdk | null = null;

export async function main(): Promise<BackupManifest> {
  return handleBackupInvocation(runtimeCloud);
}

export async function handleBackupInvocation(
  cloudFactory: () => CloudSdk,
): Promise<BackupManifest> {
  try {
    return await runBackup(cloudFactory());
  } catch (error: unknown) {
    console.error('backup-invocation-failed', { errorCode: safeDiagnosticCode(error) });
    throw redactedRuntimeError(error, 'backup task failed');
  }
}

async function runBackup(sdk: CloudSdk): Promise<BackupManifest> {
  assertScheduledTrigger(sdk.getWXContext());
  const db = sdk.database();
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
  await purgeExpiredBackups(db, sdk, now.toISOString());
  await manifests.add({ data: manifest });

  let progress = { collections: {}, fileIds: [] } as {
    collections: Record<string, { documents: number; pages: number }>;
    fileIds: string[];
  };
  try {
    for (const collectionName of BACKUP_COLLECTIONS) {
      await backupCollection(
        db,
        collectionName,
        prefix,
        async (fileId, summary) => {
          progress = appendBackupProgress(
            progress,
            collectionName,
            [fileId],
            summary,
          ) as typeof progress;
          await manifests.doc(backupId).set({
            data: { ...manifest, collections: progress.collections, fileIds: progress.fileIds },
          });
        },
        sdk,
      );
    }
    const completed: BackupManifest = {
      ...manifest,
      status: 'completed',
      collections: progress.collections,
      fileIds: progress.fileIds,
      completedAt: new Date().toISOString(),
    };
    const manifestFileId = await writeManifestFile(sdk, completed);
    const persisted = { ...completed, fileIds: [...completed.fileIds, manifestFileId] };
    await manifests.doc(backupId).set({ data: persisted });
    console.info('backup-complete', {
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
      errorCode: safeDiagnosticCode(error),
    };
    await manifests
      .doc(backupId)
      .set({ data: failed })
      .catch(() => undefined);
    const failedManifestFileId = await writeManifestFile(sdk, failed).catch(() => null);
    if (failedManifestFileId !== null) {
      await manifests
        .doc(backupId)
        .set({ data: { ...failed, fileIds: [...failed.fileIds, failedManifestFileId] } })
        .catch(() => undefined);
    }
    console.error('backup-failed', { errorCode: failed.errorCode });
    throw redactedRuntimeError(error, 'backup operation failed');
  }
}

function runtimeCloud(): CloudSdk {
  if (initializedCloud !== null) return initializedCloud;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sdk = require('wx-server-sdk') as CloudSdk;
  sdk.init({ env: sdk.DYNAMIC_CURRENT_ENV });
  initializedCloud = sdk;
  return sdk;
}

async function purgeExpiredBackups(db: Database, sdk: CloudSdk, nowIso: string): Promise<void> {
  while (true) {
    const expired = await db
      .collection<BackupManifest>('backup_manifests')
      .where({ expiresAt: db.command.lt(nowIso) })
      .limit(20)
      .get();
    if (expired.data.length === 0) return;
    for (const manifest of expired.data) {
      if (manifest.fileIds.length > 0) {
        await deleteFilesCompletely(sdk, manifest.fileIds);
      }
      await db.collection<BackupManifest>('backup_manifests').where({ _id: manifest.id }).remove();
    }
    if (expired.data.length < 20) return;
  }
}

export async function backupCollection(
  db: Database,
  collectionName: string,
  prefix: string,
  onPageUploaded: (fileId: string, summary: { documents: number; pages: number }) => Promise<void>,
  storage: Pick<CloudSdk, 'uploadFile'>,
): Promise<{
  summary: { documents: number; pages: number };
  fileIds: readonly string[];
}> {
  let documents = 0;
  const fileIds: string[] = [];
  let page = 0;
  let cursor: string | null = null;
  while (true) {
    let query = db.collection<Record<string, unknown>>(collectionName).orderBy('_id', 'asc');
    if (cursor !== null) query = query.where({ _id: db.command.gt(cursor) });
    const result = await query.limit(100).get();
    if (result.data.length === 0) break;
    const lastId = result.data.at(-1)?.['_id'];
    if (typeof lastId !== 'string' || lastId.length === 0) {
      throw Object.assign(new Error('backup document is missing a stable _id cursor'), {
        code: 'BACKUP_CURSOR_INVALID',
      });
    }
    const payload = gzipSync(Buffer.from(JSON.stringify(result.data), 'utf8'));
    const uploaded = await storage.uploadFile({
      cloudPath: pagePath(prefix, collectionName, page),
      fileContent: payload,
    });
    fileIds.push(uploaded.fileID);
    documents += result.data.length;
    page += 1;
    cursor = lastId;
    await onPageUploaded(uploaded.fileID, { documents, pages: page });
    if (result.data.length < 100) break;
  }
  return { summary: { documents, pages: page }, fileIds };
}

async function writeManifestFile(sdk: Pick<CloudSdk, 'uploadFile'>, manifest: BackupManifest) {
  const payload = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  const uploaded = await sdk.uploadFile({
    cloudPath: `${manifest.prefix}/manifest.json`,
    fileContent: payload,
  });
  return uploaded.fileID;
}
