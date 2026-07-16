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
    const after = {
      ...before,
      version: 2,
      ledgerRevision: 1,
      updatedAt: '2026-07-10T08:01:00.000Z',
    };

    const publisher = new EventPublisher(social, repository);
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
    const after = { ...before, version: 2, ledgerRevision: 1 };
    const publisher = new EventPublisher(social, repository);

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
});

function createUser(id: string, openId: string): UserDocument {
  return {
    id,
    openId,
    publicId: id === 'alice' ? 'ABCDEFGH23' : 'ABCDEFGH24',
    displayName: id,
    signature: '',
    avatarUrl: null,
    status: 'active',
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
