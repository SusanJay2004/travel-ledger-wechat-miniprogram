import { describe, expect, it, vi } from 'vitest';

vi.mock('wx-server-sdk', () => ({
  DYNAMIC_CURRENT_ENV: Symbol('test-env'),
  init: vi.fn(),
}));

import { applyAvatarReview } from './index';

type Document = Record<string, unknown>;

function database(user: Document) {
  const records = new Map([[String(user['_id']), structuredClone(user)]]);
  const db = {
    collection: <T>() => ({
      where: (query: Record<string, unknown>) => ({
        limit: () => ({
          get: async () => ({
            data: [...records.values()].filter((document) => matches(document, query)) as T[],
          }),
        }),
        update: async ({ data }: { data: Partial<T> }) => {
          const entries = [...records.entries()].filter(([, document]) => matches(document, query));
          for (const [id, document] of entries) records.set(id, { ...document, ...data });
          return { stats: { updated: entries.length } };
        },
      }),
    }),
  };
  return { db, read: () => records.values().next().value as Document };
}

describe('avatar review application', () => {
  const now = new Date('2026-07-17T01:00:00.000Z');

  it('switches to a passed candidate and queues the old avatar for deletion', async () => {
    const memory = database(user());
    await expect(
      applyAvatarReview(
        memory.db as unknown as Parameters<typeof applyAvatarReview>[0],
        { accepted: true, label: 100, traceId: 'trace-1' },
        now,
      ),
    ).resolves.toBe('applied');
    expect(memory.read()).toMatchObject({
      avatarUrl: 'cloud://env/avatars/user-1/new.jpg',
      pendingAvatarFileId: null,
      pendingAvatarReviewId: null,
      pendingFileDeletionIds: ['cloud://env/avatars/user-1/old.jpg'],
      version: 4,
    });
  });

  it('removes an accepted candidate from any stale deletion marker', async () => {
    const candidate = 'cloud://env/avatars/user-1/new.jpg';
    const memory = database(user({ pendingFileDeletionIds: [candidate] }));

    await expect(
      applyAvatarReview(
        memory.db as unknown as Parameters<typeof applyAvatarReview>[0],
        { accepted: true, label: 100, traceId: 'trace-1' },
        now,
      ),
    ).resolves.toBe('applied');

    expect(memory.read()).toMatchObject({
      avatarUrl: candidate,
      pendingFileDeletionIds: ['cloud://env/avatars/user-1/old.jpg'],
    });
  });

  it('keeps the old avatar and queues a risky candidate for deletion', async () => {
    const memory = database(user());
    await expect(
      applyAvatarReview(
        memory.db as unknown as Parameters<typeof applyAvatarReview>[0],
        { accepted: false, label: 20002, traceId: 'trace-1' },
        now,
      ),
    ).resolves.toBe('applied');
    expect(memory.read()).toMatchObject({
      avatarUrl: 'cloud://env/avatars/user-1/old.jpg',
      pendingFileDeletionIds: ['cloud://env/avatars/user-1/new.jpg'],
    });
  });

  it('rejects a pass callback that arrives after the review deadline', async () => {
    const memory = database(user({ pendingAvatarExpiresAt: '2026-07-17T00:59:59.000Z' }));
    await expect(
      applyAvatarReview(
        memory.db as unknown as Parameters<typeof applyAvatarReview>[0],
        { accepted: true, label: 100, traceId: 'trace-1' },
        now,
      ),
    ).resolves.toBe('applied');
    expect(memory.read()).toMatchObject({
      avatarUrl: 'cloud://env/avatars/user-1/old.jpg',
      pendingAvatarFileId: null,
      pendingAvatarReviewId: null,
      pendingAvatarExpiresAt: null,
      pendingFileDeletionIds: ['cloud://env/avatars/user-1/new.jpg'],
    });
  });

  it('ignores an unknown or repeated trace id', async () => {
    const memory = database(user());
    await expect(
      applyAvatarReview(
        memory.db as unknown as Parameters<typeof applyAvatarReview>[0],
        { accepted: true, label: 100, traceId: 'other' },
        now,
      ),
    ).resolves.toBe('ignored');
    expect(memory.read()).toMatchObject({ version: 3 });
  });
});

function user(overrides: Document = {}): Document {
  return {
    _id: 'user-1',
    id: 'user-1',
    avatarUrl: 'cloud://env/avatars/user-1/old.jpg',
    pendingAvatarFileId: 'cloud://env/avatars/user-1/new.jpg',
    pendingAvatarReviewId: 'trace-1',
    pendingAvatarExpiresAt: '2026-07-17T01:35:00.000Z',
    pendingFileDeletionIds: [],
    status: 'active',
    updatedAt: '2026-07-17T00:00:00.000Z',
    version: 3,
    ...overrides,
  };
}

function matches(document: Document, query: Record<string, unknown>): boolean {
  return Object.entries(query).every(([key, value]) => document[key] === value);
}
