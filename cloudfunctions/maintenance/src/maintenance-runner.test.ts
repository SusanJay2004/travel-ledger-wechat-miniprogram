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
  maintainTrip,
  type Collection,
  type Database,
  type MaintenanceTripDocument,
} from './index';

type Document = Record<string, unknown> & { id?: string; _id?: string };

class MemoryCollection<T> implements Collection<T> {
  private limitValue: number | undefined;
  private offset = 0;
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
    const documents = [...this.database.records(this.name).values()].filter((document) =>
      this.matches(document),
    );
    const end = this.limitValue === undefined ? undefined : this.offset + this.limitValue;
    return { data: structuredClone(documents.slice(this.offset, end)) as T[] };
  }

  limit(value: number): Collection<T> {
    this.limitValue = value;
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
    const records = this.database.records(this.name);
    const matches = [...records.entries()].filter(([, document]) => this.matches(document));
    for (const [id, document] of matches) {
      records.set(id, { ...document, ...(structuredClone(options.data) as Document) });
    }
    return { stats: { updated: matches.length } };
  }

  private matches(document: Document): boolean {
    return Object.entries(this.query ?? {}).every(([key, value]) => {
      if (key === '_id') return (document._id ?? document.id) === value;
      return document[key] === value;
    });
  }
}

class MemoryDatabase implements Database {
  readonly command = { lt: (value: string) => value };
  private readonly collections = new Map<string, Map<string, Document>>();
  private readonly removeFailures = new Set<string>();

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

  consumeRemoveFailure(name: string): void {
    if (!this.removeFailures.delete(name)) return;
    throw new Error(`injected ${name} remove failure`);
  }

  read<T>(name: string, id: string): T {
    return structuredClone(this.records(name).get(id)) as T;
  }
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
        ownerOpenId: 'openid-alice',
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
