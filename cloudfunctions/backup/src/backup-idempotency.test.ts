import { describe, expect, it, vi } from 'vitest';

vi.mock('wx-server-sdk', () => ({
  DYNAMIC_CURRENT_ENV: Symbol('test-env'),
  init: vi.fn(),
}));

import {
  handleBackupInvocation,
  type BackupManifest,
  type CloudSdk,
  type Collection,
  type Database,
} from './index';

type Document = Record<string, unknown> & { _id: string };
type Command = { kind: 'gt' | 'lt'; value: string };

class MemoryCollection<T> implements Collection<T> {
  constructor(
    private readonly database: MemoryDatabase,
    private readonly name: string,
    private readonly query: Record<string, unknown> = {},
    private readonly maximum = Number.POSITIVE_INFINITY,
    private readonly ordering: { field: string; direction: 'asc' | 'desc' } | null = null,
  ) {}

  async add(options: { data: T }): Promise<unknown> {
    const document = options.data as Document;
    const id = String(document._id ?? document['id'] ?? '');
    if (id.length === 0) throw new Error('document id missing');
    if (this.database.records(this.name).has(id)) {
      throw Object.assign(new Error('duplicate document'), { code: 'DUPLICATE_KEY' });
    }
    this.database.records(this.name).set(id, structuredClone({ ...document, _id: id }));
    return { _id: id };
  }

  doc(id: string): {
    get(): Promise<{ data: T }>;
    set(options: { data: T | Omit<T, '_id'> }): Promise<unknown>;
  } {
    return {
      get: async () => {
        const document = this.database.records(this.name).get(id);
        if (document === undefined) {
          throw Object.assign(new Error('document not found'), {
            errCode: 'DATABASE_DOCUMENT_NOT_FOUND',
          });
        }
        return { data: structuredClone(document) as T };
      },
      set: async (options) => {
        this.database
          .records(this.name)
          .set(id, structuredClone({ ...(options.data as Record<string, unknown>), _id: id }));
        return { stats: { updated: 1 } };
      },
    };
  }

  async get(): Promise<{ data: T[] }> {
    const selected: Document[] = [...this.database.records(this.name).values()].filter((document) =>
      Object.entries(this.query).every(([field, expected]) =>
        valueMatches(document[field], expected),
      ),
    );
    if (this.ordering !== null) {
      const { direction, field } = this.ordering;
      selected.sort((left, right) => {
        const comparison = String(left[field]).localeCompare(String(right[field]));
        return direction === 'asc' ? comparison : -comparison;
      });
    }
    return { data: structuredClone(selected.slice(0, this.maximum)) as T[] };
  }

  limit(value: number): Collection<T> {
    return new MemoryCollection(this.database, this.name, this.query, value, this.ordering);
  }

  orderBy(field: string, direction: 'asc' | 'desc'): Collection<T> {
    return new MemoryCollection(this.database, this.name, this.query, this.maximum, {
      field,
      direction,
    });
  }

  where(query: Record<string, unknown>): Collection<T> {
    return new MemoryCollection(
      this.database,
      this.name,
      { ...this.query, ...query },
      this.maximum,
      this.ordering,
    );
  }

  async remove(): Promise<{ stats?: { removed?: number } }> {
    const ids = (await this.get()).data.map((document) => String((document as Document)._id));
    for (const id of ids) this.database.records(this.name).delete(id);
    return { stats: { removed: ids.length } };
  }
}

class MemoryDatabase implements Database {
  readonly command = {
    gt: (value: string): Command => ({ kind: 'gt', value }),
    lt: (value: string): Command => ({ kind: 'lt', value }),
  };
  private readonly data = new Map<string, Map<string, Document>>();
  private readonly transactionFailures = new Set<number>();
  private readonly postCommitFailures = new Set<number>();
  private transactionQueue: Promise<void> = Promise.resolve();
  private transactionCount = 0;

  collection<T>(name: string): Collection<T> {
    return new MemoryCollection<T>(this, name);
  }

  runTransaction(
    callback: (transaction: Pick<Database, 'collection'>) => void | Promise<unknown>,
  ): Promise<unknown> {
    const run = this.transactionQueue.then(() => {
      this.transactionCount += 1;
      if (this.transactionFailures.delete(this.transactionCount)) {
        throw Object.assign(new Error('injected transaction failure'), {
          code: 'DATABASE_WRITE_FAILED',
        });
      }
      return Promise.resolve(callback(this)).then((result) => {
        if (this.postCommitFailures.delete(this.transactionCount)) {
          throw Object.assign(new Error('injected response loss after commit'), {
            code: 'DATABASE_RESPONSE_LOST',
          });
        }
        return result;
      });
    });
    this.transactionQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  records(name: string): Map<string, Document> {
    let records = this.data.get(name);
    if (records === undefined) {
      records = new Map();
      this.data.set(name, records);
    }
    return records;
  }

  seed(name: string, document: Document): void {
    this.records(name).set(document._id, structuredClone(document));
  }

  failTransaction(number: number): void {
    this.transactionFailures.add(number);
  }

  failTransactionAfterCommit(number: number): void {
    this.postCommitFailures.add(number);
  }

  readManifest(): BackupManifest {
    return structuredClone(
      this.records('backup_manifests').get('bak_20260717'),
    ) as unknown as BackupManifest;
  }
}

interface FakeSdkOptions {
  deleteFile?: CloudSdk['deleteFile'];
  uploadFile?: CloudSdk['uploadFile'];
}

function sdkFor(database: MemoryDatabase, options: FakeSdkOptions = {}): CloudSdk {
  return {
    DYNAMIC_CURRENT_ENV: Symbol('test-env'),
    database: () => database,
    deleteFile:
      options.deleteFile ??
      (async ({ fileList }) => ({
        fileList: fileList.map((fileID) => ({ fileID, status: 0 })),
      })),
    getWXContext: () => ({ SOURCE: 'wx_trigger' }),
    init: () => undefined,
    uploadFile:
      options.uploadFile ?? (async ({ cloudPath }) => ({ fileID: `cloud://test.${cloudPath}` })),
  };
}

const firstRun = new Date('2026-07-16T20:30:00.000Z');

describe('daily backup idempotency', () => {
  it('lets only one concurrent delivery export while the other reuses the running manifest', async () => {
    const database = new MemoryDatabase();
    database.seed('users', { _id: 'user-1', value: 1 });
    const gate = deferred<void>();
    const uploadStarted = deferred<void>();
    const uploadFile = vi.fn(async ({ cloudPath }: { cloudPath: string }) => {
      if (uploadFile.mock.calls.length === 1) {
        uploadStarted.resolve();
        await gate.promise;
      }
      return { fileID: `cloud://test.${cloudPath}` };
    });
    const sdk = sdkFor(database, { uploadFile });

    const primary = handleBackupInvocation(() => sdk, {
      attemptId: () => 'primary',
      now: () => firstRun,
    });
    await uploadStarted.promise;
    const duplicate = await handleBackupInvocation(() => sdk, {
      attemptId: () => 'duplicate',
      now: () => firstRun,
    });

    expect(duplicate).toMatchObject({
      id: 'bak_20260717',
      status: 'running',
      attempt: 1,
      attemptId: 'primary',
    });
    expect(uploadFile).toHaveBeenCalledTimes(1);
    gate.resolve();
    await expect(primary).resolves.toMatchObject({ status: 'completed', attemptId: 'primary' });
    expect(uploadFile).toHaveBeenCalledTimes(2);
  });

  it('reuses the completed daily manifest without uploading or extending retention', async () => {
    const database = new MemoryDatabase();
    const uploadFile = vi.fn(async ({ cloudPath }: { cloudPath: string }) => ({
      fileID: `cloud://test.${cloudPath}`,
    }));
    const sdk = sdkFor(database, { uploadFile });
    const completed = await handleBackupInvocation(() => sdk, {
      attemptId: () => 'first',
      now: () => firstRun,
    });
    const duplicate = await handleBackupInvocation(() => sdk, {
      attemptId: () => 'second',
      now: () => new Date('2026-07-17T01:00:00.000Z'),
    });

    expect(duplicate).toEqual(completed);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(completed.collections).toEqual(
      expect.objectContaining({
        users: { documents: 0, pages: 0 },
        trips: { documents: 0, pages: 0 },
        audit_logs: { documents: 0, pages: 0 },
      }),
    );
  });

  it('continues with its own claim when the claim commit response is lost', async () => {
    const database = new MemoryDatabase();
    database.failTransactionAfterCommit(1);
    const uploadFile = vi.fn(async ({ cloudPath }: { cloudPath: string }) => ({
      fileID: `cloud://test.${cloudPath}`,
    }));

    const result = await handleBackupInvocation(() => sdkFor(database, { uploadFile }), {
      attemptId: () => 'claim-owner',
      now: () => firstRun,
    });

    expect(result).toMatchObject({ status: 'completed', attempt: 1, attemptId: 'claim-owner' });
    expect(uploadFile).toHaveBeenCalledTimes(1);
  });

  it('deletes a failed attempt before retrying the same Beijing day in an isolated prefix', async () => {
    const database = new MemoryDatabase();
    database.seed('users', { _id: 'user-1', value: 1 });
    const firstUpload = vi.fn(async ({ cloudPath }: { cloudPath: string }) => {
      if (firstUpload.mock.calls.length === 2) {
        throw Object.assign(new Error('manifest upload failed'), { code: 'STORAGE_TIMEOUT' });
      }
      return { fileID: `cloud://test.${cloudPath}` };
    });
    const failedSdk = sdkFor(database, { uploadFile: firstUpload });

    await expect(
      handleBackupInvocation(() => failedSdk, {
        attemptId: () => 'failed',
        now: () => firstRun,
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_TIMEOUT', message: 'backup task failed' });
    expect(database.readManifest()).toMatchObject({
      status: 'failed',
      attempt: 1,
      attemptId: 'failed',
      fileIds: [expect.stringContaining('attempt_failed/users/00000.json.gz')],
    });

    const deleteFile = vi.fn(async ({ fileList }: { fileList: string[] }) => ({
      fileList: fileList.map((fileID) => ({ fileID, status: 0 })),
    }));
    const retryUpload = vi.fn(async ({ cloudPath }: { cloudPath: string }) => ({
      fileID: `cloud://test.${cloudPath}`,
    }));
    const completed = await handleBackupInvocation(
      () => sdkFor(database, { deleteFile, uploadFile: retryUpload }),
      {
        attemptId: () => 'retry',
        now: () => new Date('2026-07-16T20:31:00.000Z'),
      },
    );

    expect(deleteFile).toHaveBeenCalledWith({
      fileList: [expect.stringContaining('attempt_failed/users/00000.json.gz')],
    });
    expect(completed).toMatchObject({
      status: 'completed',
      attempt: 2,
      attemptId: 'retry',
      cleanupFileIds: [],
    });
    expect(completed.prefix).toContain('attempt_retry');
    expect(completed.fileIds.every((fileId) => !fileId.includes('attempt_failed'))).toBe(true);
  });

  it('records the uploaded manifest file when the final database commit fails', async () => {
    const database = new MemoryDatabase();
    database.failTransaction(3);
    const uploadFile = vi.fn(async ({ cloudPath }: { cloudPath: string }) => ({
      fileID: `cloud://test.${cloudPath}`,
    }));

    await expect(
      handleBackupInvocation(() => sdkFor(database, { uploadFile }), {
        attemptId: () => 'failed-commit',
        now: () => firstRun,
      }),
    ).rejects.toMatchObject({ code: 'DATABASE_WRITE_FAILED' });

    expect(database.readManifest()).toMatchObject({
      status: 'failed',
      errorCode: 'DATABASE_WRITE_FAILED',
      fileIds: [expect.stringContaining('attempt_failed-commit/manifest.json')],
    });
  });

  it('reconciles a completed manifest when the final commit response is lost', async () => {
    const database = new MemoryDatabase();
    database.failTransactionAfterCommit(3);
    const deleteFile = vi.fn(async ({ fileList }: { fileList: string[] }) => ({
      fileList: fileList.map((fileID) => ({ fileID, status: 0 })),
    }));

    const result = await handleBackupInvocation(() => sdkFor(database, { deleteFile }), {
      attemptId: () => 'committed',
      now: () => firstRun,
    });

    expect(result).toMatchObject({
      status: 'completed',
      attemptId: 'committed',
      pendingCloudPaths: [],
    });
    expect(database.readManifest()).toMatchObject({
      status: 'completed',
      attemptId: 'committed',
    });
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('recovers a file uploaded before its file id could be persisted', async () => {
    const database = new MemoryDatabase();
    database.seed('backup_manifests', {
      ...failedManifest(),
      fileIds: [],
      pendingCloudPaths: [
        'private-backups/2026-07-17/bak_20260717/attempt_crashed/users/00000.json.gz',
      ],
    });
    const uploadedPaths: string[] = [];
    const deletedFileIds: string[] = [];
    const sdk = sdkFor(database, {
      uploadFile: async ({ cloudPath }) => {
        uploadedPaths.push(cloudPath);
        return { fileID: `cloud://recovered.${cloudPath}` };
      },
      deleteFile: async ({ fileList }) => {
        deletedFileIds.push(...fileList);
        return { fileList: fileList.map((fileID) => ({ fileID, status: 0 })) };
      },
    });

    const result = await handleBackupInvocation(() => sdk, {
      attemptId: () => 'retry-after-crash',
      now: () => new Date('2026-07-16T20:31:00.000Z'),
    });

    expect(uploadedPaths[0]).toContain('attempt_crashed/users/00000.json.gz');
    expect(deletedFileIds[0]).toContain('attempt_crashed/users/00000.json.gz');
    expect(result).toMatchObject({
      status: 'completed',
      cleanupCloudPaths: [],
      pendingCloudPaths: [],
    });
  });

  it('refuses to overwrite a pending path outside the private backup prefix', async () => {
    const database = new MemoryDatabase();
    database.seed('backup_manifests', {
      ...failedManifest(),
      fileIds: [],
      pendingCloudPaths: ['avatars/another-user/current.png'],
    });
    const uploadFile = vi.fn();

    await expect(
      handleBackupInvocation(() => sdkFor(database, { uploadFile }), {
        attemptId: () => 'invalid-path',
        now: () => new Date('2026-07-16T20:31:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'BACKUP_CLOUD_PATH_INVALID' });
    expect(uploadFile).not.toHaveBeenCalled();
    expect(database.readManifest()).toMatchObject({
      status: 'failed',
      cleanupCloudPaths: ['avatars/another-user/current.png'],
    });
  });

  it('fails closed on incomplete cleanup and retains old file ids for a later retry', async () => {
    const database = new MemoryDatabase();
    database.seed('backup_manifests', failedManifest());
    const uploadFile = vi.fn(async ({ cloudPath }: { cloudPath: string }) => ({
      fileID: `cloud://test.${cloudPath}`,
    }));
    const failingDelete = vi.fn(async ({ fileList }: { fileList: string[] }) => ({
      fileList: fileList.map((fileID) => ({ fileID, status: -1 })),
    }));

    await expect(
      handleBackupInvocation(() => sdkFor(database, { deleteFile: failingDelete, uploadFile }), {
        attemptId: () => 'retry-1',
        now: () => new Date('2026-07-16T20:31:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'FILE_DELETE_INCOMPLETE' });
    expect(uploadFile).not.toHaveBeenCalled();
    expect(database.readManifest()).toMatchObject({
      status: 'failed',
      attempt: 2,
      cleanupFileIds: ['cloud://old/page'],
      fileIds: [],
    });

    const successfulDelete = vi.fn(async ({ fileList }: { fileList: string[] }) => ({
      fileList: fileList.map((fileID) => ({ fileID, status: 0 })),
    }));
    await expect(
      handleBackupInvocation(() => sdkFor(database, { deleteFile: successfulDelete, uploadFile }), {
        attemptId: () => 'retry-2',
        now: () => new Date('2026-07-16T20:32:00.000Z'),
      }),
    ).resolves.toMatchObject({ status: 'completed', attempt: 3, cleanupFileIds: [] });
    expect(successfulDelete).toHaveBeenCalledWith({ fileList: ['cloud://old/page'] });
  });

  it('takes over an expired lease but preserves a recent legacy running invocation', async () => {
    const expiredDatabase = new MemoryDatabase();
    expiredDatabase.seed('backup_manifests', {
      ...failedManifest(),
      status: 'running',
      attemptId: 'expired',
      attemptStartedAt: '2026-07-16T19:00:00.000Z',
      leaseExpiresAt: '2026-07-16T19:15:00.000Z',
    });
    const deleteFile = vi.fn(async ({ fileList }: { fileList: string[] }) => ({
      fileList: fileList.map((fileID) => ({ fileID, status: 0 })),
    }));
    await expect(
      handleBackupInvocation(() => sdkFor(expiredDatabase, { deleteFile }), {
        attemptId: () => 'takeover',
        now: () => firstRun,
      }),
    ).resolves.toMatchObject({ status: 'completed', attemptId: 'takeover', attempt: 2 });
    expect(deleteFile).toHaveBeenCalledWith({ fileList: ['cloud://old/page'] });

    const legacyDatabase = new MemoryDatabase();
    const legacy = failedManifest();
    delete legacy.attempt;
    delete legacy.attemptId;
    delete legacy.attemptStartedAt;
    delete legacy.leaseExpiresAt;
    delete legacy.cleanupFileIds;
    legacy.status = 'running';
    legacy.createdAt = '2026-07-16T20:25:00.000Z';
    legacyDatabase.seed('backup_manifests', legacy);
    const uploadFile = vi.fn();
    const preserved = await handleBackupInvocation(() => sdkFor(legacyDatabase, { uploadFile }), {
      attemptId: () => 'must-not-take-over',
      now: () => firstRun,
    });
    expect(preserved).toMatchObject({ status: 'running', attempt: 0, attemptId: 'legacy' });
    expect(uploadFile).not.toHaveBeenCalled();
  });
});

function failedManifest(): Document & Partial<BackupManifest> {
  return {
    _id: 'bak_20260717',
    id: 'bak_20260717',
    day: '2026-07-17',
    status: 'failed',
    prefix: 'private-backups/2026-07-17/bak_20260717/attempt_old',
    attempt: 1,
    attemptId: 'old',
    attemptStartedAt: '2026-07-16T19:00:00.000Z',
    leaseExpiresAt: null,
    collections: { users: { documents: 1, pages: 1 } },
    createdAt: '2026-07-16T19:00:00.000Z',
    completedAt: '2026-07-16T19:01:00.000Z',
    expiresAt: '2026-08-15T19:00:00.000Z',
    errorCode: 'STORAGE_TIMEOUT',
    fileIds: ['cloud://old/page'],
    cleanupFileIds: [],
    pendingCloudPaths: [],
    cleanupCloudPaths: [],
  };
}

function valueMatches(actual: unknown, expected: unknown): boolean {
  if (typeof expected === 'object' && expected !== null && 'kind' in expected) {
    const command = expected as Command;
    if (command.kind === 'gt') return String(actual) > command.value;
    return String(actual) < command.value;
  }
  return actual === expected;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}
