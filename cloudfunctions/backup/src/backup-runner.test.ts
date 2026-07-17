import { gunzipSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

vi.mock('wx-server-sdk', () => ({
  DYNAMIC_CURRENT_ENV: Symbol('test-env'),
  init: vi.fn(),
}));

import { backupCollection, handleBackupInvocation, type Collection, type Database } from './index';

type Document = Record<string, unknown> & { _id: string };
type Command = { kind: 'gt' | 'lt'; value: string };

describe('backup invocation diagnostics', () => {
  it('rethrows only a generic error and a bounded diagnostic code', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const privateError = Object.assign(new Error('private https://storage.test/credential'), {
      code: 'BACKUP_SDK_FAILED',
      headers: { authorization: 'private-token' },
    });
    try {
      const result = handleBackupInvocation(() => {
        throw privateError;
      });
      await expect(result).rejects.toMatchObject({
        code: 'BACKUP_SDK_FAILED',
        message: 'backup task failed',
      });
      await expect(result).rejects.not.toHaveProperty('cause');
      expect(log).toHaveBeenCalledWith('backup-invocation-failed', {
        errorCode: 'BACKUP_SDK_FAILED',
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain('private');
    } finally {
      log.mockRestore();
    }
  });
});

class MemoryCollection<T> implements Collection<T> {
  private maximum = Number.POSITIVE_INFINITY;
  private order: 'asc' | 'desc' = 'asc';
  private query: Record<string, unknown> = {};

  constructor(private readonly records: Map<string, Document>) {}

  add(): Promise<unknown> {
    throw new Error('not implemented');
  }

  doc(): {
    get(): Promise<{ data: T }>;
    set(options: { data: T | Omit<T, '_id'> }): Promise<unknown>;
  } {
    throw new Error('not implemented');
  }

  async get(): Promise<{ data: T[] }> {
    const matches = [...this.records.values()].filter((document) =>
      Object.entries(this.query).every(([field, expected]) => {
        const value = String(document[field]);
        const command = expected as Command;
        if (command.kind === 'gt') return value > command.value;
        if (command.kind === 'lt') return value < command.value;
        return document[field] === expected;
      }),
    );
    matches.sort((left, right) =>
      this.order === 'asc' ? left._id.localeCompare(right._id) : right._id.localeCompare(left._id),
    );
    return { data: structuredClone(matches.slice(0, this.maximum)) as T[] };
  }

  limit(value: number): Collection<T> {
    this.maximum = value;
    return this;
  }

  orderBy(_field: string, direction: 'asc' | 'desc'): Collection<T> {
    this.order = direction;
    return this;
  }

  where(query: Record<string, unknown>): Collection<T> {
    this.query = query;
    return this;
  }

  remove(): Promise<{ stats?: { removed?: number } }> {
    throw new Error('not implemented');
  }
}

describe('backup collection runner', () => {
  it('persists the deterministic path before upload and the file id after upload', async () => {
    const collection = new MemoryCollection<Record<string, unknown>>(
      new Map([['doc_001', { _id: 'doc_001', value: 1 }]]),
    );
    const db: Database = {
      collection: <T>() => collection as unknown as Collection<T>,
      command: {
        gt: (value) => ({ kind: 'gt', value }),
        lt: (value) => ({ kind: 'lt', value }),
      },
      runTransaction: async () => undefined,
    };
    const calls: string[] = [];

    await backupCollection(
      db,
      'users',
      'private-backups/test',
      async (cloudPath) => {
        calls.push(`before:${cloudPath}`);
      },
      async (cloudPath, fileId) => {
        calls.push(`after:${cloudPath}:${fileId}`);
      },
      {
        uploadFile: async ({ cloudPath }) => {
          calls.push(`upload:${cloudPath}`);
          return { fileID: `cloud://${cloudPath}` };
        },
      },
    );

    expect(calls).toEqual([
      'before:private-backups/test/users/00000.json.gz',
      'upload:private-backups/test/users/00000.json.gz',
      'after:private-backups/test/users/00000.json.gz:cloud://private-backups/test/users/00000.json.gz',
    ]);
  });

  it('uses a stable id cursor so deletions behind the cursor cannot skip later documents', async () => {
    const records = new Map<string, Document>(
      Array.from({ length: 101 }, (_, index) => {
        const id = `doc_${String(index).padStart(3, '0')}`;
        return [id, { _id: id, value: index }];
      }),
    );
    const collection = new MemoryCollection<Record<string, unknown>>(records);
    const db: Database = {
      collection: <T>() => collection as unknown as Collection<T>,
      command: {
        gt: (value) => ({ kind: 'gt', value }),
        lt: (value) => ({ kind: 'lt', value }),
      },
      runTransaction: async () => undefined,
    };
    const pages: Document[][] = [];
    const storage = {
      uploadFile: vi.fn(
        async ({ cloudPath, fileContent }: { cloudPath: string; fileContent: Buffer }) => {
          const parsed: unknown = JSON.parse(gunzipSync(fileContent).toString('utf8'));
          pages.push(parsed as Document[]);
          return { fileID: `cloud://${cloudPath}` };
        },
      ),
    };

    const result = await backupCollection(
      db,
      'users',
      'private-backups/test',
      async () => undefined,
      async (_cloudPath, _fileId, summary) => {
        if (summary.pages === 1) {
          records.delete('doc_050');
          records.set('doc_050a', { _id: 'doc_050a', value: 'inserted-behind-cursor' });
        }
      },
      storage,
    );

    expect(result.summary).toEqual({ documents: 101, pages: 2 });
    expect(pages[1]?.map((document) => document._id)).toEqual(['doc_100']);
    expect(pages.flat().map((document) => document._id)).not.toContain('doc_050a');
  });

  it('rejects records without a string document id instead of silently looping', async () => {
    const collection = new MemoryCollection<Record<string, unknown>>(
      new Map([['broken', { _id: '', value: 1 }]]),
    );
    const db: Database = {
      collection: <T>() => collection as unknown as Collection<T>,
      command: {
        gt: (value) => ({ kind: 'gt', value }),
        lt: (value) => ({ kind: 'lt', value }),
      },
      runTransaction: async () => undefined,
    };

    await expect(
      backupCollection(
        db,
        'users',
        'private-backups/test',
        async () => undefined,
        async () => undefined,
        {
          uploadFile: async () => ({ fileID: 'unused' }),
        },
      ),
    ).rejects.toMatchObject({ code: 'BACKUP_CURSOR_INVALID' });
  });
});
