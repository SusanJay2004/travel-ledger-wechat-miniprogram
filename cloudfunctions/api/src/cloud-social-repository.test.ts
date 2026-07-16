import { describe, expect, it } from 'vitest';

import { CloudSocialRepository } from './cloud-social-repository';
import type { AuditLogDocument, FriendshipDocument, NotificationDocument } from './models';
import { MemoryCloudDatabase } from './testing/memory-cloud';

describe('CloudSocialRepository pagination', () => {
  it('finds and lists friendships beyond the first 100 documents', async () => {
    const database = new MemoryCloudDatabase();
    const repository = new CloudSocialRepository(database);
    for (let index = 0; index < 101; index += 1) {
      await repository.createFriendship(friendship(index));
    }

    expect(await repository.listFriendships('alice')).toHaveLength(101);
    expect(await repository.getFriendship('alice', 'friend-100')).toMatchObject({
      id: 'friendship-100',
    });
  });

  it('returns notifications and audit logs from every page in newest-first order', async () => {
    const database = new MemoryCloudDatabase();
    const repository = new CloudSocialRepository(database);
    for (let index = 0; index < 101; index += 1) {
      await repository.createNotification(notification(index));
      await repository.createAuditLog(auditLog(index));
    }

    const notifications = await repository.listNotifications('alice');
    const logs = await repository.listAuditLogs('trip-1');
    expect(notifications).toHaveLength(101);
    expect(notifications[0]?.id).toBe('notification-100');
    expect(notifications.at(-1)?.id).toBe('notification-000');
    expect(logs).toHaveLength(101);
    expect(logs[0]?.id).toBe('audit-100');
    expect(logs.at(-1)?.id).toBe('audit-000');
  });

  it('lists invitations involving a user across both directions without duplicates', async () => {
    const database = new MemoryCloudDatabase();
    const repository = new CloudSocialRepository(database);
    const collection = database.collection<Record<string, unknown>>('trip_invitations');
    for (let index = 0; index < 101; index += 1) {
      await collection.add({
        data: {
          _id: `invitation-${index}`,
          id: `invitation-${index}`,
          tripId: 'trip-1',
          inviterUserId: index % 2 === 0 ? 'alice' : `friend-${index}`,
          inviteeUserId: index % 2 === 0 ? `friend-${index}` : 'alice',
          status: 'pending',
          createdAt: '2026-07-17T00:00:00.000Z',
          expiresAt: '2026-07-24T00:00:00.000Z',
          respondedAt: null,
        },
      });
    }

    expect(await repository.listInvitations('alice')).toHaveLength(101);
  });
});

function friendship(index: number): FriendshipDocument {
  const suffix = String(index).padStart(3, '0');
  return {
    id: `friendship-${suffix}`,
    userIds: ['alice', `friend-${suffix}`],
    createdAt: `2026-07-17T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
  };
}

function notification(index: number): NotificationDocument {
  const suffix = String(index).padStart(3, '0');
  return {
    id: `notification-${suffix}`,
    userId: 'alice',
    type: 'trip_completed',
    actorUserId: null,
    tripId: 'trip-1',
    requestId: null,
    invitationId: null,
    title: '行程更新',
    body: '行程更新',
    readAt: null,
    createdAt: `2026-07-${String(index + 1).padStart(3, '0')}T00:00:00.000Z`,
  };
}

function auditLog(index: number): AuditLogDocument {
  const suffix = String(index).padStart(3, '0');
  return {
    id: `audit-${suffix}`,
    tripId: 'trip-1',
    actorUserId: 'alice',
    action: 'bill.updated',
    entityType: 'bill',
    entityId: `bill-${suffix}`,
    beforeVersion: index,
    afterVersion: index + 1,
    createdAt: `2026-07-${String(index + 1).padStart(3, '0')}T00:00:00.000Z`,
  };
}
