import { createHash } from 'node:crypto';

import type { AuditLogDocument, SyncEventDocument, TripDocument } from './models';
import type { Repository } from './repository';
import type { SocialRepository } from './social-repository';

export class EventPublisher {
  constructor(
    private readonly social: SocialRepository,
    private readonly repository: Repository,
  ) {}

  async publishTripCreated(after: TripDocument, actorUserId: string): Promise<void> {
    const log: AuditLogDocument = {
      id: deterministicId('aud', after.id, String(after.version), 'trip.created'),
      tripId: after.id,
      actorUserId,
      action: 'trip.created',
      entityType: 'trip',
      entityId: after.id,
      beforeVersion: 0,
      afterVersion: after.version,
      createdAt: after.createdAt,
    };
    await this.social.createAuditLog(log).catch(() => {
      console.error('trip-create-audit-failed', { tripId: after.id });
    });
  }

  async publishTripChange(
    before: TripDocument,
    after: TripDocument,
    action: string,
    actorUserId: string,
    entityType: AuditLogDocument['entityType'],
    entityId: string,
  ): Promise<void> {
    const createdAt = after.updatedAt;
    const log: AuditLogDocument = {
      id: deterministicId('aud', after.id, String(after.version), action),
      tripId: after.id,
      actorUserId,
      action,
      entityType,
      entityId,
      beforeVersion: before.version,
      afterVersion: after.version,
      createdAt,
    };
    const failures: unknown[] = [];
    await this.social.createAuditLog(log).catch((error: unknown) => failures.push(error));
    await Promise.all(
      after.memberIds.map(async (userId) => {
        const user = await this.repository.getUser(userId);
        if (user === null) {
          failures.push(new Error(`Missing sync target user ${userId}`));
          return;
        }
        const event: SyncEventDocument = {
          id: deterministicId('syn', after.id, String(after.version), action, userId),
          userId,
          ownerOpenId: user.openId,
          tripId: after.id,
          ledgerRevision: after.ledgerRevision,
          action,
          actorUserId,
          createdAt,
        };
        await this.social.createSyncEvent(event).catch((error: unknown) => failures.push(error));
      }),
    );
    if (failures.length > 0) {
      console.error('trip-change-publish-failed', {
        tripId: after.id,
        version: after.version,
        action,
        failureCount: failures.length,
      });
    }
  }
}

function deterministicId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}
