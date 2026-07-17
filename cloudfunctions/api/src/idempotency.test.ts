import { describe, expect, it } from 'vitest';

import type { CloudCollection, CloudDatabase, QueryResult, UpdateResult } from './cloud-repository';
import { BusinessError } from './errors';
import { IdempotencyService, isWriteAction } from './idempotency';
import type { Clock, IdempotencyRecordDocument } from './models';

class TestClock implements Clock {
  now() {
    return new Date('2026-07-17T08:00:00.000Z');
  }
}

class MemoryCloudDatabase implements CloudDatabase {
  readonly documents = new Map<string, unknown>();
  failCompletedWrite = false;

  collection<T>(_name: string): CloudCollection<T> {
    return new MemoryCloudCollection<T>(this);
  }

  async runTransaction(): Promise<never> {
    throw new Error('not used by idempotency tests');
  }
}

class MemoryCloudCollection<T> implements CloudCollection<T> {
  constructor(private readonly database: MemoryCloudDatabase) {}

  async add(options: { data: T }) {
    const id = documentId(options.data);
    if (this.database.documents.has(id)) throw new Error('duplicate document');
    this.database.documents.set(id, structuredClone(options.data));
  }

  doc(id: string) {
    return {
      get: async () => {
        const data = this.database.documents.get(id);
        if (data === undefined) throw new Error('document not found');
        return { data: structuredClone(data) as T };
      },
      remove: async () => {
        this.database.documents.delete(id);
      },
      set: async (options: { data: T }) => {
        const record = options.data as IdempotencyRecordDocument;
        if (this.database.failCompletedWrite && record.status === 'completed') {
          throw new Error('completion write failed');
        }
        this.database.documents.set(id, structuredClone(options.data));
      },
    };
  }

  async get(): Promise<QueryResult<T>> {
    return { data: [...this.database.documents.values()] as T[] };
  }

  limit(_value: number): CloudCollection<T> {
    return this;
  }

  skip(_value: number): CloudCollection<T> {
    return this;
  }

  where(_query: Record<string, unknown>): CloudCollection<T> {
    return this;
  }

  async update(_options: { data: Partial<T> }): Promise<UpdateResult> {
    return { stats: { updated: 0 } };
  }

  async remove(): Promise<UpdateResult> {
    this.database.documents.clear();
    return { stats: { updated: 1 } };
  }
}

describe('IdempotencyService', () => {
  it('classifies every ledger mutation including date deletion as a write', () => {
    expect(isWriteAction('trip.deleteDate')).toBe(true);
    expect(isWriteAction('trip.clearArchived')).toBe(true);
    expect(isWriteAction('trip.calculate')).toBe(false);
  });
  it('returns the stored response without executing a duplicate request', async () => {
    const database = new MemoryCloudDatabase();
    const service = new IdempotencyService(database, new TestClock());
    let calls = 0;
    const operation = async () => ({ tripId: `trip-${++calls}` });

    const first = await service.execute(
      'openid-alice',
      'request-123',
      'trip.create',
      { name: '青岛', options: { year: 2026, note: undefined } },
      operation,
    );
    const replay = await service.execute(
      'openid-alice',
      'request-123',
      'trip.create',
      { options: { year: 2026 }, name: '青岛' },
      operation,
    );

    expect(first).toEqual({ tripId: 'trip-1' });
    expect(replay).toEqual(first);
    expect(calls).toBe(1);
  });

  it('stores domain failures and never reruns the same failed request', async () => {
    const service = new IdempotencyService(new MemoryCloudDatabase(), new TestClock());
    let calls = 0;
    const operation = async () => {
      calls += 1;
      throw new BusinessError('TRIP_NAME_INVALID', '行程名称格式不正确。');
    };

    await expect(
      service.execute('openid-alice', 'request-456', 'trip.create', { name: '青岛' }, operation),
    ).rejects.toMatchObject({ code: 'TRIP_NAME_INVALID' });
    await expect(
      service.execute('openid-alice', 'request-456', 'trip.create', { name: '青岛' }, operation),
    ).rejects.toMatchObject({ code: 'TRIP_NAME_INVALID' });
    expect(calls).toBe(1);
  });

  it('keeps an uncertain request locked if persisting its result fails', async () => {
    const database = new MemoryCloudDatabase();
    database.failCompletedWrite = true;
    const service = new IdempotencyService(database, new TestClock());
    let calls = 0;
    const operation = async () => ++calls;

    await expect(
      service.execute('openid-alice', 'request-789', 'trip.create', { name: '青岛' }, operation),
    ).rejects.toMatchObject({ code: 'REQUEST_RESULT_UNCERTAIN' });
    await expect(
      service.execute('openid-alice', 'request-789', 'trip.create', { name: '青岛' }, operation),
    ).rejects.toMatchObject({ code: 'REQUEST_IN_PROGRESS' });
    expect(calls).toBe(1);
  });

  it('rejects reuse of an id for different content even when the action is unchanged', async () => {
    const service = new IdempotencyService(new MemoryCloudDatabase(), new TestClock());
    let calls = 0;
    const operation = async () => ++calls;

    await expect(
      service.execute(
        'openid-alice',
        'request-content',
        'trip.create',
        { name: '青岛' },
        operation,
      ),
    ).resolves.toBe(1);
    await expect(
      service.execute(
        'openid-alice',
        'request-content',
        'trip.create',
        { name: '北京' },
        operation,
      ),
    ).rejects.toMatchObject({ code: 'REQUEST_ID_REUSED' });
    expect(calls).toBe(1);
  });

  it('preserves array order when fingerprinting a write payload', async () => {
    const service = new IdempotencyService(new MemoryCloudDatabase(), new TestClock());
    const operation = async () => 'saved';

    await service.execute(
      'openid-alice',
      'request-array-order',
      'trip.updateBill',
      { participantIds: ['alice', 'bob'] },
      operation,
    );
    await expect(
      service.execute(
        'openid-alice',
        'request-array-order',
        'trip.updateBill',
        { participantIds: ['bob', 'alice'] },
        operation,
      ),
    ).rejects.toMatchObject({ code: 'REQUEST_ID_REUSED' });
  });
});

function documentId(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('_id' in value)) {
    throw new Error('document id required');
  }
  return String(value._id);
}
