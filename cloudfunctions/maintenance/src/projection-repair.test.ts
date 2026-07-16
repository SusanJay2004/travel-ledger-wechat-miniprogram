import { describe, expect, it } from 'vitest';

import { buildProjectionDocuments } from './projection-repair';

describe('buildProjectionDocuments', () => {
  it('rebuilds deterministic audit, sync and lifecycle notification projections', () => {
    const users = new Map([
      ['alice', { id: 'alice', openId: 'openid-a', status: 'active' }],
      ['bob', { id: 'bob', openId: 'openid-b', status: 'active' }],
    ]);
    const projection = {
      id: 'out-1',
      action: 'trip.completed',
      actorUserId: 'alice',
      entityType: 'trip' as const,
      entityId: 'trip-1',
      beforeVersion: 2,
      afterVersion: 3,
      ledgerRevision: 2,
      targetUserIds: ['alice', 'bob'],
      notification: {
        type: 'trip_completed',
        title: '行程已完结',
        body: '“旅行”已完结',
        targetUserIds: ['alice', 'bob'],
      },
      createdAt: '2026-07-17T08:00:00.000Z',
    };

    const first = buildProjectionDocuments(
      { id: 'trip-1', name: '旅行', version: 3 },
      projection,
      users,
    );
    const replay = buildProjectionDocuments(
      { id: 'trip-1', name: '旅行', version: 3 },
      projection,
      users,
    );
    expect(replay).toEqual(first);
    expect(first.syncEvents).toHaveLength(2);
    expect(first.notifications).toHaveLength(2);
    expect(first.missingUserIds).toEqual([]);
  });

  it('retains the outbox when a sync target identity cannot be resolved', () => {
    const result = buildProjectionDocuments(
      { id: 'trip-1', name: '旅行', version: 2 },
      {
        id: 'out-1',
        action: 'bill.created',
        actorUserId: 'alice',
        entityType: 'bill',
        entityId: 'bill-1',
        beforeVersion: 1,
        afterVersion: 2,
        ledgerRevision: 1,
        targetUserIds: ['missing'],
        createdAt: '2026-07-17T08:00:00.000Z',
      },
      new Map(),
    );
    expect(result.missingUserIds).toEqual(['missing']);
    expect(result.syncEvents).toEqual([]);
  });

  it('skips sync for a deleted account without blocking audit repair', () => {
    const result = buildProjectionDocuments(
      { id: 'trip-1', name: '旅行', version: 2 },
      {
        id: 'out-1',
        action: 'member.account_deleted',
        actorUserId: 'alice',
        entityType: 'member',
        entityId: 'alice',
        beforeVersion: 1,
        afterVersion: 2,
        ledgerRevision: 1,
        targetUserIds: ['alice'],
        createdAt: '2026-07-17T08:00:00.000Z',
      },
      new Map([['alice', { id: 'alice', openId: 'deleted:alice', status: 'deleted' }]]),
    );
    expect(result.missingUserIds).toEqual([]);
    expect(result.syncEvents).toEqual([]);
  });
});
