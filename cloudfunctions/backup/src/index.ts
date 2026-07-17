import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { redactedRuntimeError, safeDiagnosticCode } from '@travel-ledger/domain';

import {
  BACKUP_COLLECTIONS,
  appendBackupProgress,
  backupDay,
  backupIdForDay,
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
    get(): Promise<{ data: T }>;
    set(options: { data: T | Omit<T, '_id'> }): Promise<unknown>;
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
  runTransaction(
    callback: (transaction: Pick<Database, 'collection'>) => void | Promise<unknown>,
    retries?: number,
  ): Promise<unknown>;
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

export interface BackupManifest {
  _id: string;
  id: string;
  day: string;
  status: 'running' | 'completed' | 'failed';
  prefix: string;
  attempt: number;
  attemptId: string;
  attemptStartedAt: string;
  leaseExpiresAt: string | null;
  collections: Readonly<Record<string, { documents: number; pages: number }>>;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string;
  errorCode: string | null;
  fileIds: readonly string[];
  cleanupFileIds: readonly string[];
  pendingCloudPaths: readonly string[];
  cleanupCloudPaths: readonly string[];
}

interface LegacyBackupManifest extends Partial<BackupManifest> {
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

interface BackupExecutionOptions {
  attemptId?: () => string;
  now?: () => Date;
}

type BackupClaim =
  | { kind: 'claimed'; manifest: BackupManifest }
  | { kind: 'completed' | 'running'; manifest: BackupManifest };

const BACKUP_LEASE_MS = 20 * 60 * 1000;

let initializedCloud: CloudSdk | null = null;

export async function main(): Promise<BackupManifest> {
  return handleBackupInvocation(runtimeCloud);
}

export async function handleBackupInvocation(
  cloudFactory: () => CloudSdk,
  options: BackupExecutionOptions = {},
): Promise<BackupManifest> {
  try {
    return await runBackup(cloudFactory(), options);
  } catch (error: unknown) {
    console.error('backup-invocation-failed', { errorCode: safeDiagnosticCode(error) });
    throw redactedRuntimeError(error, 'backup task failed');
  }
}

async function runBackup(sdk: CloudSdk, options: BackupExecutionOptions): Promise<BackupManifest> {
  assertScheduledTrigger(sdk.getWXContext());
  const db = sdk.database();
  const clock = options.now ?? (() => new Date());
  const now = clock();
  const day = backupDay(now);
  const backupId = backupIdForDay(day);
  const attemptId = (options.attemptId ?? defaultAttemptId)();
  const claim = await claimDailyBackup(db, now, day, backupId, attemptId);
  if (claim.kind !== 'claimed') return claim.manifest;

  let manifest = claim.manifest;

  let progress = { collections: {}, fileIds: [] } as {
    collections: Record<string, { documents: number; pages: number }>;
    fileIds: string[];
  };
  let finalManifestFileId: string | null = null;
  try {
    await purgeExpiredBackups(db, sdk, now.toISOString());
    if (manifest.cleanupFileIds.length > 0 || manifest.cleanupCloudPaths.length > 0) {
      if (manifest.cleanupFileIds.length > 0) {
        await deleteFilesCompletely(sdk, manifest.cleanupFileIds);
      }
      if (manifest.cleanupCloudPaths.length > 0) {
        await recoverAndDeletePendingFiles(sdk, manifest.cleanupCloudPaths);
      }
      manifest = renewLease({ ...manifest, cleanupFileIds: [], cleanupCloudPaths: [] }, clock());
      await persistOwnedManifest(db, manifest);
    }
    for (const collectionName of BACKUP_COLLECTIONS) {
      const collectionBackup = await backupCollection(
        db,
        collectionName,
        manifest.prefix,
        async (cloudPath) => {
          manifest = renewLease(
            {
              ...manifest,
              pendingCloudPaths: uniqueStrings([...manifest.pendingCloudPaths, cloudPath]),
            },
            clock(),
          );
          await persistOwnedManifest(db, manifest);
        },
        async (cloudPath, fileId, summary) => {
          progress = appendBackupProgress(
            progress,
            collectionName,
            [fileId],
            summary,
          ) as typeof progress;
          manifest = renewLease(
            {
              ...manifest,
              collections: progress.collections,
              fileIds: progress.fileIds,
              pendingCloudPaths: manifest.pendingCloudPaths.filter((item) => item !== cloudPath),
            },
            clock(),
          );
          await persistOwnedManifest(db, manifest);
        },
        sdk,
      );
      if (collectionBackup.summary.pages === 0) {
        progress = appendBackupProgress(
          progress,
          collectionName,
          [],
          collectionBackup.summary,
        ) as typeof progress;
        manifest = { ...manifest, collections: progress.collections };
      }
    }
    const completed: BackupManifest = {
      ...manifest,
      status: 'completed',
      collections: progress.collections,
      fileIds: progress.fileIds,
      completedAt: clock().toISOString(),
      leaseExpiresAt: null,
    };
    const finalManifestCloudPath = manifestPath(completed.prefix);
    manifest = renewLease(
      {
        ...manifest,
        pendingCloudPaths: uniqueStrings([...manifest.pendingCloudPaths, finalManifestCloudPath]),
      },
      clock(),
    );
    await persistOwnedManifest(db, manifest);
    finalManifestFileId = await writeManifestFile(sdk, completed, finalManifestCloudPath);
    const persisted = {
      ...completed,
      fileIds: [...completed.fileIds, finalManifestFileId],
      pendingCloudPaths: [],
    };
    const reconciled = await persistCompletedManifest(db, persisted, day);
    console.info('backup-complete', {
      collections: Object.keys(progress.collections).length,
      documents: Object.values(progress.collections).reduce((sum, item) => sum + item.documents, 0),
    });
    return reconciled;
  } catch (error: unknown) {
    if (shouldSkipFailureTransition(error)) {
      console.error('backup-failed', { errorCode: safeDiagnosticCode(error) });
      throw redactedRuntimeError(error, 'backup operation failed');
    }
    const failed: BackupManifest = {
      ...manifest,
      status: 'failed',
      collections: progress.collections,
      fileIds: uniqueFileIds([
        ...progress.fileIds,
        ...(finalManifestFileId === null ? [] : [finalManifestFileId]),
      ]),
      completedAt: clock().toISOString(),
      leaseExpiresAt: null,
      errorCode: safeDiagnosticCode(error),
    };
    const failureRecorded = await persistOwnedManifest(db, failed).then(
      () => true,
      () => false,
    );
    if (!failureRecorded) {
      if (failed.fileIds.length > 0) {
        await deleteFilesCompletely(sdk, failed.fileIds).catch(() => undefined);
      }
      if (failed.pendingCloudPaths.length > 0) {
        await recoverAndDeletePendingFiles(sdk, failed.pendingCloudPaths).catch(() => undefined);
      }
    }
    console.error('backup-failed', { errorCode: failed.errorCode });
    throw redactedRuntimeError(error, 'backup operation failed');
  }
}

function defaultAttemptId(): string {
  return randomUUID().replaceAll('-', '');
}

async function claimDailyBackup(
  db: Database,
  now: Date,
  day: string,
  backupId: string,
  attemptId: string,
): Promise<BackupClaim> {
  let claim: BackupClaim | null = null;
  try {
    await db.runTransaction(async (transaction) => {
      const reference = transaction
        .collection<LegacyBackupManifest>('backup_manifests')
        .doc(backupId);
      const current = await readManifest(reference);
      if (current?.status === 'completed') {
        claim = { kind: 'completed', manifest: normalizeManifest(current, day) };
        return;
      }
      if (current?.status === 'running' && current.attemptId === attemptId) {
        claim = { kind: 'claimed', manifest: normalizeManifest(current, day) };
        return;
      }
      if (current?.status === 'running' && manifestLeaseIsActive(current, now)) {
        claim = { kind: 'running', manifest: normalizeManifest(current, day) };
        return;
      }

      const previousFiles = uniqueFileIds([
        ...(current?.cleanupFileIds ?? []),
        ...(current?.fileIds ?? []),
      ]);
      const previousCloudPaths = uniqueStrings([
        ...(current?.cleanupCloudPaths ?? []),
        ...(current?.pendingCloudPaths ?? []),
      ]);
      const manifest: BackupManifest = {
        _id: backupId,
        id: backupId,
        day,
        status: 'running',
        prefix: backupPrefix(day, backupId, attemptId),
        attempt: (current?.attempt ?? 0) + 1,
        attemptId,
        attemptStartedAt: now.toISOString(),
        leaseExpiresAt: leaseExpiry(now),
        collections: {},
        createdAt: current?.createdAt ?? now.toISOString(),
        completedAt: null,
        expiresAt: expiresAt(now),
        errorCode: null,
        fileIds: [],
        cleanupFileIds: previousFiles,
        pendingCloudPaths: [],
        cleanupCloudPaths: previousCloudPaths,
      };
      await reference.set({ data: withoutDocumentId(manifest) });
      claim = { kind: 'claimed', manifest };
    });
  } catch (error: unknown) {
    const current = await readManifest(
      db.collection<LegacyBackupManifest>('backup_manifests').doc(backupId),
    ).catch(() => null);
    if (current?.status === 'running' && current.attemptId === attemptId) {
      claim = { kind: 'claimed', manifest: normalizeManifest(current, day) };
    } else if (current?.status === 'completed' && current.attemptId === attemptId) {
      claim = { kind: 'completed', manifest: normalizeManifest(current, day) };
    } else {
      throw error;
    }
  }
  if (claim === null) throw diagnosticError('BACKUP_CLAIM_EMPTY');
  return claim;
}

async function persistOwnedManifest(db: Database, manifest: BackupManifest): Promise<void> {
  await db.runTransaction(async (transaction) => {
    const reference = transaction.collection<BackupManifest>('backup_manifests').doc(manifest.id);
    const current = (await reference.get()).data;
    if (current.attemptId !== manifest.attemptId || current.status !== 'running') {
      throw diagnosticError('BACKUP_OWNERSHIP_LOST');
    }
    await reference.set({ data: withoutDocumentId(manifest) });
  });
}

async function persistCompletedManifest(
  db: Database,
  manifest: BackupManifest,
  day: string,
): Promise<BackupManifest> {
  try {
    await persistOwnedManifest(db, manifest);
    return manifest;
  } catch (error: unknown) {
    let current: LegacyBackupManifest | null;
    try {
      current = await readManifest(
        db.collection<LegacyBackupManifest>('backup_manifests').doc(manifest.id),
      );
    } catch {
      throw Object.assign(new Error('final backup commit outcome is unknown'), {
        code: 'BACKUP_FINAL_COMMIT_UNKNOWN',
        skipFailureTransition: true,
      });
    }
    if (current?.status === 'completed' && current.attemptId === manifest.attemptId) {
      return normalizeManifest(current, day);
    }
    throw error;
  }
}

function renewLease(manifest: BackupManifest, now: Date): BackupManifest {
  return { ...manifest, leaseExpiresAt: leaseExpiry(now) };
}

function leaseExpiry(now: Date): string {
  return new Date(now.getTime() + BACKUP_LEASE_MS).toISOString();
}

function leaseIsActive(value: string | null | undefined, now: Date): boolean {
  if (typeof value !== 'string') return false;
  const lease = Date.parse(value);
  return Number.isFinite(lease) && lease > now.getTime();
}

function manifestLeaseIsActive(manifest: LegacyBackupManifest, now: Date): boolean {
  if (leaseIsActive(manifest.leaseExpiresAt, now)) return true;
  if (manifest.leaseExpiresAt !== undefined) return false;
  const startedAt = Date.parse(manifest.attemptStartedAt ?? manifest.createdAt);
  return Number.isFinite(startedAt) && startedAt + BACKUP_LEASE_MS > now.getTime();
}

function normalizeManifest(manifest: LegacyBackupManifest, day: string): BackupManifest {
  const startedAt = manifest.attemptStartedAt ?? manifest.createdAt;
  return {
    ...manifest,
    day: manifest.day ?? day,
    attempt: manifest.attempt ?? 0,
    attemptId: manifest.attemptId ?? 'legacy',
    attemptStartedAt: startedAt,
    leaseExpiresAt:
      manifest.leaseExpiresAt === undefined
        ? new Date(Date.parse(startedAt) + BACKUP_LEASE_MS).toISOString()
        : manifest.leaseExpiresAt,
    cleanupFileIds: manifest.cleanupFileIds ?? [],
    pendingCloudPaths: manifest.pendingCloudPaths ?? [],
    cleanupCloudPaths: manifest.cleanupCloudPaths ?? [],
  };
}

async function readManifest(
  reference: ReturnType<Collection<LegacyBackupManifest>['doc']>,
): Promise<LegacyBackupManifest | null> {
  try {
    return (await reference.get()).data;
  } catch (error: unknown) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function withoutDocumentId(manifest: BackupManifest): Omit<BackupManifest, '_id'> {
  const { _id: _documentId, ...data } = manifest;
  return data;
}

function uniqueFileIds(fileIds: readonly string[]): string[] {
  return uniqueStrings(fileIds);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function diagnosticError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function shouldSkipFailureTransition(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'skipFailureTransition' in error &&
    error.skipFailureTransition === true
  );
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as Readonly<Record<string, unknown>>;
  const value = [record['errCode'], record['code'], record['message']]
    .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
    .join(' ')
    .toLowerCase();
  return value.includes('document_not_found') || value.includes('not found');
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
      .collection<LegacyBackupManifest>('backup_manifests')
      .where({ expiresAt: db.command.lt(nowIso) })
      .limit(20)
      .get();
    if (expired.data.length === 0) return;
    for (const manifest of expired.data) {
      const fileIds = uniqueFileIds([
        ...(manifest.cleanupFileIds ?? []),
        ...(manifest.fileIds ?? []),
      ]);
      if (fileIds.length > 0) {
        await deleteFilesCompletely(sdk, fileIds);
      }
      const pendingCloudPaths = uniqueStrings([
        ...(manifest.cleanupCloudPaths ?? []),
        ...(manifest.pendingCloudPaths ?? []),
      ]);
      if (pendingCloudPaths.length > 0) {
        await recoverAndDeletePendingFiles(sdk, pendingCloudPaths);
      }
      await db
        .collection<LegacyBackupManifest>('backup_manifests')
        .where({ _id: manifest.id })
        .remove();
    }
    if (expired.data.length < 20) return;
  }
}

export async function backupCollection(
  db: Database,
  collectionName: string,
  prefix: string,
  onPageUploading: (cloudPath: string) => Promise<void>,
  onPageUploaded: (
    cloudPath: string,
    fileId: string,
    summary: { documents: number; pages: number },
  ) => Promise<void>,
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
    const cloudPath = pagePath(prefix, collectionName, page);
    await onPageUploading(cloudPath);
    const uploaded = await storage.uploadFile({
      cloudPath,
      fileContent: payload,
    });
    fileIds.push(uploaded.fileID);
    documents += result.data.length;
    page += 1;
    cursor = lastId;
    await onPageUploaded(cloudPath, uploaded.fileID, { documents, pages: page });
    if (result.data.length < 100) break;
  }
  return { summary: { documents, pages: page }, fileIds };
}

function manifestPath(prefix: string): string {
  return `${prefix}/manifest.json`;
}

async function writeManifestFile(
  sdk: Pick<CloudSdk, 'uploadFile'>,
  manifest: BackupManifest,
  cloudPath: string,
) {
  const payload = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  const uploaded = await sdk.uploadFile({
    cloudPath,
    fileContent: payload,
  });
  return uploaded.fileID;
}

async function recoverAndDeletePendingFiles(
  sdk: Pick<CloudSdk, 'uploadFile' | 'deleteFile'>,
  cloudPaths: readonly string[],
): Promise<void> {
  const placeholder = Buffer.from('{"status":"discarded"}\n', 'utf8');
  for (const cloudPath of uniqueStrings(cloudPaths)) {
    if (!isPrivateBackupPath(cloudPath)) {
      throw diagnosticError('BACKUP_CLOUD_PATH_INVALID');
    }
    const uploaded = await sdk.uploadFile({ cloudPath, fileContent: placeholder });
    await deleteFilesCompletely(sdk, [uploaded.fileID]);
  }
}

function isPrivateBackupPath(value: string): boolean {
  return (
    value.startsWith('private-backups/') &&
    !value.includes('..') &&
    !value.includes('\\') &&
    value.length <= 512
  );
}
