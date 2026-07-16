import { describe, expect, it } from 'vitest';

import { EventPublisher } from './event-publisher';
import type { TripDocument, UserDocument } from './models';
import { MemoryRepository } from './repository';
import { MemorySocialRepository } from './social-repository';

class FailingSocialRepository extends MemorySocialRepository {
  override async createAuditLog() {
    throw new Error('audit unavailable');
  }

  override async createSyncEvent() {
    throw new Error('sync unavailable');
  }
}

describe('EventPublisher', () => {
  it('writes one owner-scoped sync event per member plus an audit log', async () => {
    const repository = new MemoryRepository();
    const social = new MemorySocialRepository();
    const users: UserDocument[] = [
      createUser('alice', 'openid-alice'),
      createUser('bob', 'openid-bob'),
    ];
    for (const user of users) await repository.createUser(user);
    const before = createTrip(
      1,
      users.map((user) => user.id),
    );
    const changed = {
      ...before,
      version: 2,
      ledgerRevision: 1,
      updatedAt: '2026-07-10T08:01:00.000Z',
    };

    const publisher = new EventPublisher(social, repository);
    const after = publisher.prepareTripChange(
      before,
      changed,
      'bill.created',
      'alice',
      'bill',
      'bill-1',
    );
    await publisher.publishTripChange(before, after, 'bill.created', 'alice', 'bill', 'bill-1');

    expect(await social.listAuditLogs(after.id)).toEqual([
      expect.objectContaining({
        action: 'bill.created',
        actorUserId: 'alice',
        beforeVersion: 1,
        afterVersion: 2,
      }),
    ]);
    const events = social.listSyncEventsForTest();
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.ownerOpenId).sort()).toEqual(['openid-alice', 'openid-bob']);
  });

  it('uses deterministic projection ids when the same change is published again', async () => {
    const repository = new MemoryRepository();
    const social = new MemorySocialRepository();
    await repository.createUser(createUser('alice', 'openid-alice'));
    const before = createTrip(1, ['alice']);
    const publisher = new EventPublisher(social, repository);
    const after = publisher.prepareTripChange(
      before,
      { ...before, version: 2, ledgerRevision: 1 },
      'date.created',
      'alice',
      'date',
      '2026-07-10',
    );

    await publisher.publishTripChange(before, after, 'date.created', 'alice', 'date', '2026-07-10');
    await publisher.publishTripChange(before, after, 'date.created', 'alice', 'date', '2026-07-10');

    expect(await social.listAuditLogs(after.id)).toHaveLength(1);
    expect(social.listSyncEventsForTest()).toHaveLength(1);
  });

  it('does not turn a committed ledger write into a client-visible failure', async () => {
    const repository = new MemoryRepository();
    await repository.createUser(createUser('alice', 'openid-alice'));
    const before = createTrip(1, ['alice']);
    const after = { ...before, version: 2 };
    const publisher = new EventPublisher(new FailingSocialRepository(), repository);

    await expect(
      publisher.publishTripChange(before, after, 'trip.renamed', 'alice', 'trip', after.id),
    ).resolves.toBeUndefined();
  });

  it('stores an outbox entry before commit and clears it after every projection succeeds', async () => {
    const repository = new MemoryRepository();
    const social = new MemorySocialRepository();
    await repository.createUser(createUser('alice', 'openid-alice'));
    const publisher = new EventPublisher(social, repository);
    const before = createTrip(1, ['alice']);
    await repository.createTrip(before);
    const after = publisher.prepareTripChange(
      before,
      { ...before, version: 2, ledgerRevision: 1 },
      'bill.created',
      'alice',
      'bill',
      'bill-1',
    );
    expect(after.projectionOutbox).toHaveLength(1);
    await repository.replaceTrip(after, before.version);

    await publisher.publishTripChange(before, after, 'bill.created', 'alice', 'bill', 'bill-1');

    expect((await repository.getTrip(before.id))?.projectionOutbox).toEqual([]);
    expect(await social.listAuditLogs(before.id)).toHaveLength(1);
    expect(social.listSyncEventsForTest()).toHaveLength(1);
  });

  it('retains an outbox entry when a projection fails for later maintenance replay', async () => {
    const repository = new MemoryRepository();
    await repository.createUser(createUser('alice', 'openid-alice'));
    const before = createTrip(1, ['alice']);
    await repository.createTrip(before);
    const publisher = new EventPublisher(new FailingSocialRepository(), repository);
    const after = publisher.prepareTripChange(
      before,
      { ...before, version: 2, ledgerRevision: 1 },
      'bill.created',
      'alice',
      'bill',
      'bill-1',
    );
    await repository.replaceTrip(after, before.version);

    await publisher.publishTripChange(before, after, 'bill.created', 'alice', 'bill', 'bill-1');

    expect((await repository.getTrip(before.id))?.projectionOutbox).toHaveLength(1);
  });

  it('does not reset an existing lifecycle notification to unread when replayed', async () => {
    const repository = new MemoryRepository();
    const social = new MemorySocialRepository();
    await repository.createUser(createUser('alice', 'openid-alice'));
    const before = createTrip(1, ['alice']);
    const publisher = new EventPublisher(social, repository);
    const after = publisher.prepareTripChange(
      before,
      { ...before, status: 'completed', version: 2, ledgerRevision: 1 },
      'trip.completed',
      'alice',
      'trip',
      before.id,
    );

    await publisher.publishTripChange(before, after, 'trip.completed', 'alice', 'trip', before.id);
    const notification = (await social.listNotifications('alice'))[0]!;
    await social.markNotificationRead(notification.id, 'alice', '2026-07-10T09:00:00.000Z');
    await publisher.publishTripChange(before, after, 'trip.completed', 'alice', 'trip', before.id);

    expect((await social.listNotifications('alice'))[0]?.readAt).toBe('2026-07-10T09:00:00.000Z');
  });

  it('does not notify a permanently detached historical member about lifecycle changes', async () => {
    const repository = new MemoryRepository();
    const social = new MemorySocialRepository();
    await repository.createUser(createUser('alice', 'openid-alice'));
    await repository.createUser(createUser('bob', 'openid-bob'));
    const before = createTrip(1, ['alice', 'bob']);
    before.members = before.members.map((member) =>
      member.userId === 'bob' ? { ...member, viewState: 'detached' as const } : member,
    );
    const publisher = new EventPublisher(social, repository);
    const after = publisher.prepareTripChange(
      before,
      { ...before, status: 'completed', version: 2, ledgerRevision: 1 },
      'trip.completed',
      'alice',
      'trip',
      before.id,
    );

    await publisher.publishTripChange(before, after, 'trip.completed', 'alice', 'trip', before.id);

    expect(await social.listNotifications('alice')).toHaveLength(1);
    expect(await social.listNotifications('bob')).toEqual([]);
    expect(after.projectionOutbox?.[0]?.targetUserIds).toEqual(['alice']);
    expect(after.projectionOutbox?.[0]?.notification?.targetUserIds).toEqual(['alice']);
  });
});

function createUser(id: string, openId: string): UserDocument {
  return {
    id,
    openId,
    publicId: id === 'alice' ? 'ABCDEFGH23' : 'ABCDEFGH24',
    displayName: id,
    signature: '',
    avatarUrl: null,
    homeTripCount: 0,
    status: 'active',
    version: 1,
    createdAt: '2026-07-10T08:00:00.000Z',
    updatedAt: '2026-07-10T08:00:00.000Z',
  };
}

function createTrip(version: number, memberIds: string[]): TripDocument {
  return {
    id: 'trip-1',
    name: '同行旅行',
    status: 'active',
    memberIds,
    members: memberIds.map((userId) => ({
      userId,
      displayNameSnapshot: userId,
      joinedAt: '2026-07-10T08:00:00.000Z',
      viewState: 'home',
      archivedAt: null,
      purgeAfter: null,
    })),
    dates: [],
    bills: [],
    totalCents: 0,
    invalidBillCount: 0,
    version,
    ledgerRevision: 0,
    createdBy: 'alice',
    createdAt: '2026-07-10T08:00:00.000Z',
    updatedBy: 'alice',
    updatedAt: '2026-07-10T08:00:00.000Z',
    completedAt: null,
    completedBy: null,
  };
}
