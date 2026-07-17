import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('wx-server-sdk', () => ({
  default: undefined,
  DYNAMIC_CURRENT_ENV: Symbol('test-env'),
  init: vi.fn(),
  database: vi.fn(),
  deleteFile: vi.fn(),
  getWXContext: vi.fn(() => ({})),
}));

import {
  expireAvatarReviews,
  expireStagedAvatars,
  maintainTrip,
  resumeDeletingAccounts,
  visitDocumentsById,
  type Collection,
  type Database,
  type MaintenanceTripDocument,
} from './index';

type Document = Record<string, unknown> & { id?: string; _id?: string };

class MemoryCollection<T> implements Collection<T> {
  private limitValue: number | undefined;
  private offset = 0;
  private order: 'asc' | 'desc' | undefined;
  private query: Record<string, unknown> | undefined;

  constructor(
    private readonly database: MemoryDatabase,
    private readonly name: string,
  ) {}

  async add(options: { data: T }): Promise<unknown> {
    const document = structuredClone(options.data) as Document;
    const id = String(document._id ?? document.id);
    const records = this.database.records(this.name);
    if (records.has(id)) throw new Error('duplicate document');
    records.set(id, document);
    return {};
  }

  doc(id: string): {
    get(): Promise<{ data: T }>;
    set(options: { data: T }): Promise<unknown>;
  } {
    return {
      get: async () => {
        const document = this.database.records(this.name).get(id);
        if (document === undefined) {
          throw Object.assign(new Error('not found'), {
            errCode: 'DATABASE_DOCUMENT_NOT_FOUND',
          });
        }
        return { data: structuredClone(document) as T };
      },
      set: async (options) => {
        this.database.records(this.name).set(id, structuredClone(options.data) as Document);
        return {};
      },
    };
  }

  async get(): Promise<{ data: T[] }> {
    const documents = [...this.database.records(this.name).values()]
      .filter((document) => this.matches(document))
      .sort((left, right) => {
        if (this.order === undefined) return 0;
        const comparison = String(left._id ?? left.id).localeCompare(String(right._id ?? right.id));
        return this.order === 'asc' ? comparison : -comparison;
      });
    const end = this.limitValue === undefined ? undefined : this.offset + this.limitValue;
    return { data: structuredClone(documents.slice(this.offset, end)) as T[] };
  }

  limit(value: number): Collection<T> {
    this.limitValue = value;
    return this;
  }

  orderBy(_field: string, direction: 'asc' | 'desc'): Collection<T> {
    this.order = direction;
    return this;
  }

  skip(value: number): Collection<T> {
    this.offset = value;
    return this;
  }

  where(query: Record<string, unknown>): Collection<T> {
    this.query = query;
    return this;
  }

  async remove(): Promise<{ stats: { removed: number } }> {
    this.database.consumeRemoveFailure(this.name);
    const records = this.database.records(this.name);
    const ids = [...records.entries()]
      .filter(([, document]) => this.matches(document))
      .map(([id]) => id);
    ids.forEach((id) => records.delete(id));
    return { stats: { removed: ids.length } };
  }

  async update(options: { data: Partial<T> }): Promise<{ stats: { updated: number } }> {
    if (this.database.consumeUpdateConflict(this.name)) return { stats: { updated: 0 } };
    const records = this.database.records(this.name);
    const matches = [...records.entries()].filter(([, document]) => this.matches(document));
    for (const [id, document] of matches) {
      records.set(id, { ...document, ...(structuredClone(options.data) as Document) });
    }
    return { stats: { updated: matches.length } };
  }

  private matches(document: Document): boolean {
    return Object.entries(this.query ?? {}).every(([key, value]) => {
      const actual = key === '_id' ? (document._id ?? document.id) : document[key];
      if (isCommand(value)) {
        return value.kind === 'gt' ? String(actual) > value.value : String(actual) < value.value;
      }
      if (key === '_id') return actual === value;
      if (Array.isArray(actual)) return actual.includes(value);
      return document[key] === value;
    });
  }
}

class MemoryDatabase implements Database {
  readonly command = {
    gt: (value: string) => ({ kind: 'gt' as const, value }),
    lt: (value: string) => ({ kind: 'lt' as const, value }),
  };
  private readonly collections = new Map<string, Map<string, Document>>();
  private readonly removeFailures = new Set<string>();
  private readonly updateConflicts = new Set<string>();

  collection<T>(name: string): Collection<T> {
    return new MemoryCollection<T>(this, name);
  }

  records(name: string): Map<string, Document> {
    let records = this.collections.get(name);
    if (records === undefined) {
      records = new Map();
      this.collections.set(name, records);
    }
    return records;
  }

  seed(name: string, document: Document): void {
    const id = String(document._id ?? document.id);
    this.records(name).set(id, structuredClone(document));
  }

  failNextRemove(name: string): void {
    this.removeFailures.add(name);
  }

  conflictNextUpdate(name: string): void {
    this.updateConflicts.add(name);
  }

  consumeUpdateConflict(name: string): boolean {
    return this.updateConflicts.delete(name);
  }

  consumeRemoveFailure(name: string): void {
    if (!this.removeFailures.delete(name)) return;
    throw new Error(`injected ${name} remove failure`);
  }

  read<T>(name: string, id: string): T {
    return structuredClone(this.records(name).get(id)) as T;
  }
}

function isCommand(value: unknown): value is { kind: 'gt' | 'lt'; value: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value.kind === 'gt' || value.kind === 'lt') &&
    'value' in value &&
    typeof value.value === 'string'
  );
}

const now = new Date('2026-08-20T00:00:00.000Z');

function trip(overrides: Partial<MaintenanceTripDocument> = {}): MaintenanceTripDocument {
  return {
    id: 'trip-1',
    name: '旅行',
    memberIds: ['alice'],
    members: [
      {
        userId: 'alice',
        viewState: 'home',
        archivedAt: null,
        purgeAfter: null,
      },
    ],
    bills: [
      { id: 'old-bill', deletedAt: '2026-07-01T00:00:00.000Z' },
      { id: 'active-bill', deletedAt: null },
    ],
    ledgerRevision: 4,
    projectionOutbox: [],
    settlementCache: { ledgerRevision: 4 },
    version: 7,
    updatedAt: '2026-08-01T00:00:00.000Z',
    updatedBy: 'alice',
    ...overrides,
  };
}

describe('maintainTrip', () => {
  let database: MemoryDatabase;

  beforeEach(() => {
    database = new MemoryDatabase();
    database.seed('users', {
      _id: 'alice',
      id: 'alice',
      openId: 'openid-alice',
      status: 'active',
    });
  });

  it('turns cleanup into a versioned ledger mutation and publishes a sync event', async () => {
    const listed = trip();
    database.seed('trips', { _id: listed.id, ...listed });

    const result = await maintainTrip(database, listed, now);
    const persisted = database.read<MaintenanceTripDocument>('trips', listed.id);
    const syncEvents = [...database.records('sync_events').values()];

    expect(result).toMatchObject({ tripsUpdated: 1, projectionsRepaired: 1 });
    expect(persisted.bills.map((bill) => bill.id)).toEqual(['active-bill']);
    expect(persisted.version).toBe(8);
    expect(persisted.ledgerRevision).toBe(5);
    expect(persisted.settlementCache).toBeNull();
    expect(persisted.projectionOutbox).toEqual([]);
    expect(syncEvents).toEqual([
      expect.objectContaining({
        userId: 'alice',
        tripId: listed.id,
        ledgerRevision: 5,
        action: 'trip.maintained',
        actorUserId: 'system:maintenance',
      }),
    ]);
  });

  it('rereads after repairing old projections and never writes a delivered entry back', async () => {
    const oldProjection = {
      id: 'out-old',
      action: 'bill.created',
      actorUserId: 'alice',
      entityType: 'bill' as const,
      entityId: 'old-bill',
      beforeVersion: 6,
      afterVersion: 7,
      ledgerRevision: 4,
      targetUserIds: ['alice'],
      createdAt: '2026-08-01T00:00:00.000Z',
    };
    const listed = trip({ projectionOutbox: [oldProjection] });
    database.seed('trips', { _id: listed.id, ...listed });

    const result = await maintainTrip(database, listed, now);
    const persisted = database.read<MaintenanceTripDocument>('trips', listed.id);
    const actions = [...database.records('sync_events').values()].map((event) => event.action);

    expect(result).toMatchObject({ tripsUpdated: 1, projectionsRepaired: 2 });
    expect(persisted.projectionOutbox).toEqual([]);
    expect(actions).toEqual(expect.arrayContaining(['bill.created', 'trip.maintained']));
  });

  it('does not overwrite cleanup data while an unrecoverable outbox is at capacity', async () => {
    const pending = Array.from({ length: 1000 }, (_, index) => ({
      id: `out-${index}`,
      action: 'bill.updated',
      actorUserId: 'alice',
      entityType: 'bill' as const,
      entityId: 'old-bill',
      beforeVersion: index,
      afterVersion: index + 1,
      ledgerRevision: index + 1,
      targetUserIds: ['missing-user'],
      createdAt: '2026-08-01T00:00:00.000Z',
    }));
    const listed = trip({ projectionOutbox: pending });
    database.seed('trips', { _id: listed.id, ...listed });

    const result = await maintainTrip(database, listed, now);
    const persisted = database.read<MaintenanceTripDocument>('trips', listed.id);

    expect(result).toMatchObject({ tripsUpdated: 0, projectionFailures: 1001 });
    expect(persisted.version).toBe(7);
    expect(persisted.ledgerRevision).toBe(4);
    expect(persisted.settlementCache).toEqual({ ledgerRevision: 4 });
    expect(persisted.bills).toHaveLength(2);
    expect(persisted.projectionOutbox).toHaveLength(1000);
  });

  it('keeps an orphan trip discoverable until every related collection is cleaned', async () => {
    const orphan = trip({
      bills: [],
      members: [
        {
          userId: 'alice',
          viewState: 'detached',
          archivedAt: now.toISOString(),
          purgeAfter: now.toISOString(),
        },
      ],
    });
    database.seed('trips', { _id: orphan.id, ...orphan });
    database.seed('audit_logs', { _id: 'audit-1', id: 'audit-1', tripId: orphan.id });
    database.seed('notifications', {
      _id: 'notification-1',
      id: 'notification-1',
      tripId: orphan.id,
    });
    database.failNextRemove('audit_logs');

    await expect(maintainTrip(database, orphan, now)).rejects.toThrow(
      'injected audit_logs remove failure',
    );
    expect(database.records('trips').has(orphan.id)).toBe(true);

    await expect(maintainTrip(database, orphan, now)).resolves.toMatchObject({
      orphanTripsRemoved: 1,
    });
    expect(database.records('trips').has(orphan.id)).toBe(false);
    expect(database.records('audit_logs')).toHaveLength(0);
    expect(database.records('notifications')).toHaveLength(0);
  });
});

describe('maintenance cursor pagination', () => {
  it('does not skip later documents when a record behind the cursor disappears', async () => {
    const database = new MemoryDatabase();
    for (let index = 0; index < 101; index += 1) {
      const id = `trip-${String(index).padStart(3, '0')}`;
      database.seed('trips', { _id: id, id });
    }
    const visited: string[] = [];

    await visitDocumentsById<{ id: string }>(database, 'trips', {}, async (documents) => {
      visited.push(...documents.map((document) => document.id));
      if (visited.length === 100) database.records('trips').delete('trip-050');
    });

    expect(visited).toHaveLength(101);
    expect(visited.at(-1)).toBe('trip-100');
  });
});

describe('expired avatar review maintenance', () => {
  it('clears an expired candidate and queues its cloud file for durable deletion', async () => {
    const database = new MemoryDatabase();
    database.seed('users', {
      _id: 'alice',
      id: 'alice',
      avatarUrl: 'cloud://env/avatars/alice/current.jpg',
      pendingAvatarFileId: 'cloud://env/avatars/alice/candidate.jpg',
      pendingAvatarReviewId: 'trace-expired',
      pendingAvatarExpiresAt: '2026-08-19T23:59:59.000Z',
      pendingFileDeletionIds: ['cloud://env/avatars/alice/older.jpg'],
      status: 'active',
      updatedAt: '2026-08-19T23:00:00.000Z',
      version: 4,
    });

    await expect(expireAvatarReviews(database, now.toISOString())).resolves.toBe(1);
    expect(database.read<Document>('users', 'alice')).toMatchObject({
      avatarUrl: 'cloud://env/avatars/alice/current.jpg',
      pendingAvatarFileId: null,
      pendingAvatarReviewId: null,
      pendingAvatarExpiresAt: null,
      pendingFileDeletionIds: [
        'cloud://env/avatars/alice/older.jpg',
        'cloud://env/avatars/alice/candidate.jpg',
      ],
      updatedAt: now.toISOString(),
      version: 5,
    });
  });

  it('leaves a future review untouched', async () => {
    const database = new MemoryDatabase();
    database.seed('users', {
      _id: 'alice',
      id: 'alice',
      pendingAvatarFileId: 'cloud://env/avatars/alice/candidate.jpg',
      pendingAvatarReviewId: 'trace-pending',
      pendingAvatarExpiresAt: '2026-08-20T00:00:01.000Z',
      pendingFileDeletionIds: [],
      status: 'active',
      updatedAt: '2026-08-19T23:00:00.000Z',
      version: 4,
    });

    await expect(expireAvatarReviews(database, now.toISOString())).resolves.toBe(0);
    expect(database.read<Document>('users', 'alice')).toMatchObject({
      pendingAvatarReviewId: 'trace-pending',
      version: 4,
    });
  });
});

describe('expired staged avatar maintenance', () => {
  it('clears an unused staged avatar and queues its cloud file for deletion', async () => {
    const database = new MemoryDatabase();
    database.seed('users', {
      _id: 'alice',
      id: 'alice',
      stagedAvatarFileId: 'cloud://env/avatars/alice/staged.jpg',
      stagedAvatarToken: 'avatar-stage-token',
      stagedAvatarExpiresAt: '2026-08-19T23:59:59.000Z',
      pendingFileDeletionIds: [],
      status: 'active',
      updatedAt: '2026-08-19T23:00:00.000Z',
      version: 4,
    });

    await expect(expireStagedAvatars(database, now.toISOString())).resolves.toBe(1);
    expect(database.read<Document>('users', 'alice')).toMatchObject({
      stagedAvatarFileId: null,
      stagedAvatarToken: null,
      stagedAvatarExpiresAt: null,
      pendingFileDeletionIds: ['cloud://env/avatars/alice/staged.jpg'],
      version: 5,
    });
  });
});

describe('interrupted account deletion maintenance', () => {
  it('anonymizes remaining ledger references, purges social data, and releases WeChat identity', async () => {
    const database = new MemoryDatabase();
    database.seed('users', {
      _id: 'alice',
      id: 'alice',
      openId: 'openid-alice',
      publicId: 'ALICE12345',
      status: 'deleting',
      version: 5,
      updatedAt: '2026-08-19T23:00:00.000Z',
    });
    const alreadyDone = trip({
      id: 'trip-already-done',
      memberIds: ['alice', 'bob'],
      members: [
        {
          userId: 'alice',
          displayNameSnapshot: '已注销用户',
          viewState: 'detached',
          archivedAt: null,
          purgeAfter: null,
        },
        {
          userId: 'bob',
          displayNameSnapshot: '小博',
          viewState: 'home',
          archivedAt: null,
          purgeAfter: null,
        },
      ],
      bills: [],
      version: 4,
    });
    const remaining = trip({
      id: 'trip-remaining',
      memberIds: ['alice', 'bob'],
      members: [
        {
          userId: 'alice',
          displayNameSnapshot: '小艾',
          viewState: 'home',
          archivedAt: null,
          purgeAfter: null,
        },
        {
          userId: 'bob',
          displayNameSnapshot: '小博',
          viewState: 'home',
          archivedAt: null,
          purgeAfter: null,
        },
      ],
      bills: [
        {
          id: 'shared-bill',
          deletedAt: null,
          amountCents: 1200,
          participants: [
            { memberId: 'alice', displayName: '小艾', shares: 1 },
            { memberId: 'bob', displayName: '小博', shares: 1 },
          ],
          payers: [{ memberId: 'alice', displayName: '小艾', paidCents: 1200 }],
        },
      ],
      version: 7,
    });
    database.seed('trips', { _id: alreadyDone.id, ...alreadyDone });
    database.seed('trips', { _id: remaining.id, ...remaining });
    database.seed('friendships', {
      _id: 'friendship-1',
      id: 'friendship-1',
      userIds: ['alice', 'bob'],
    });
    database.seed('notifications', {
      _id: 'notice-1',
      id: 'notice-1',
      userId: 'bob',
      actorUserId: 'alice',
    });
    database.seed('friendships', {
      _id: 'friendship-unrelated',
      id: 'friendship-unrelated',
      userIds: ['bob', 'carol'],
    });
    database.seed('notifications', {
      _id: 'notice-unrelated',
      id: 'notice-unrelated',
      userId: 'bob',
      actorUserId: 'carol',
    });

    await expect(resumeDeletingAccounts(database, now)).resolves.toEqual({
      completed: 1,
      conflicts: 0,
      tripsUpdated: 1,
    });

    expect(database.read<MaintenanceTripDocument>('trips', alreadyDone.id).version).toBe(4);
    const anonymized = database.read<MaintenanceTripDocument>('trips', remaining.id);
    expect(anonymized.members[0]).toMatchObject({
      displayNameSnapshot: '已注销用户',
      viewState: 'detached',
    });
    expect(anonymized.bills[0]).toMatchObject({
      amountCents: 1200,
      participants: [
        expect.objectContaining({ memberId: 'alice', displayName: '已注销用户', shares: 1 }),
        expect.objectContaining({ memberId: 'bob', displayName: '小博', shares: 1 }),
      ],
      payers: [
        expect.objectContaining({ memberId: 'alice', displayName: '已注销用户', paidCents: 1200 }),
      ],
    });
    expect([...database.records('friendships').keys()]).toEqual(['friendship-unrelated']);
    expect([...database.records('notifications').keys()]).toEqual(['notice-unrelated']);
    expect(database.read<Document>('users', 'alice')).toMatchObject({
      openId: 'deleted:alice',
      publicId: 'deleted:alice',
      status: 'deleted',
      version: 6,
    });
  });

  it('keeps the account deleting when a trip version conflicts and succeeds on the next run', async () => {
    const database = new MemoryDatabase();
    database.seed('users', {
      _id: 'alice',
      id: 'alice',
      openId: 'openid-alice',
      publicId: 'ALICE12345',
      status: 'deleting',
      version: 5,
      updatedAt: '2026-08-19T23:00:00.000Z',
    });
    const remaining = trip({
      memberIds: ['alice', 'bob'],
      members: [
        {
          userId: 'alice',
          displayNameSnapshot: '小艾',
          viewState: 'home',
          archivedAt: null,
          purgeAfter: null,
        },
        {
          userId: 'bob',
          displayNameSnapshot: '小博',
          viewState: 'home',
          archivedAt: null,
          purgeAfter: null,
        },
      ],
    });
    database.seed('trips', { _id: remaining.id, ...remaining });
    database.conflictNextUpdate('trips');

    await expect(resumeDeletingAccounts(database, now)).resolves.toEqual({
      completed: 0,
      conflicts: 1,
      tripsUpdated: 0,
    });
    expect(database.read<Document>('users', 'alice').status).toBe('deleting');

    await expect(resumeDeletingAccounts(database, now)).resolves.toEqual({
      completed: 1,
      conflicts: 0,
      tripsUpdated: 1,
    });
    expect(database.read<Document>('users', 'alice').status).toBe('deleted');
  });
});
