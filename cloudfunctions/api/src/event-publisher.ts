import { createHash } from 'node:crypto';

import { LIMITS } from '@travel-ledger/domain';

import { BusinessError } from './errors';
import type { AuditLogDocument, SyncEventDocument, TripDocument } from './models';
import type { Repository } from './repository';
import type { SocialRepository } from './social-repository';

export class EventPublisher {
  constructor(
    private readonly social: SocialRepository,
    private readonly repository: Repository,
  ) {}

  prepareTripCreated(after: TripDocument, actorUserId: string): TripDocument {
    return appendOutbox(after, {
      action: 'trip.created',
      actorUserId,
      entityType: 'trip',
      entityId: after.id,
      beforeVersion: 0,
    });
  }

  prepareTripChange(
    before: TripDocument,
    after: TripDocument,
    action: string,
    actorUserId: string,
    entityType: AuditLogDocument['entityType'],
    entityId: string,
  ): TripDocument {
    const notification = notificationProjection(before, after, action, actorUserId);
    return appendOutbox(after, {
      action,
      actorUserId,
      entityType,
      entityId,
      beforeVersion: before.version,
      ...(notification === undefined ? {} : { notification }),
    });
  }

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
    const failures: unknown[] = [];
    await this.social.createAuditLog(log).catch((error: unknown) => failures.push(error));
    const projection = after.projectionOutbox?.find(
      (entry) => entry.afterVersion === after.version && entry.action === 'trip.created',
    );
    await Promise.all(
      (projection?.targetUserIds ?? []).map(async (userId) => {
        const user = await this.repository.getUser(userId);
        if (user === null) {
          failures.push(new Error(`Missing sync target user ${userId}`));
          return;
        }
        await this.social
          .createSyncEvent({
            id: deterministicId('syn', after.id, String(after.version), 'trip.created', userId),
            userId,
            ownerOpenId: user.openId,
            tripId: after.id,
            ledgerRevision: after.ledgerRevision,
            action: 'trip.created',
            actorUserId,
            createdAt: after.createdAt,
          })
          .catch((error: unknown) => failures.push(error));
      }),
    );
    if (failures.length === 0) await this.clearProjection(after, 'trip.created');
    else
      console.error('trip-create-projection-failed', {
        tripId: after.id,
        failureCount: failures.length,
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
    const projection = after.projectionOutbox?.find(
      (entry) => entry.afterVersion === after.version && entry.action === action,
    );
    await Promise.all(
      (projection?.targetUserIds ?? []).map(async (userId) => {
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
    if (projection?.notification !== undefined) {
      await Promise.all(
        projection.notification.targetUserIds.map(async (userId) => {
          await this.social
            .createNotification({
              id: deterministicId('not', after.id, String(after.version), action, userId),
              userId,
              type: projection.notification!.type,
              actorUserId,
              tripId: after.id,
              requestId: null,
              invitationId: null,
              title: projection.notification!.title,
              body: projection.notification!.body,
              readAt: null,
              createdAt,
            })
            .catch((error: unknown) => failures.push(error));
        }),
      );
    }
    if (failures.length > 0) {
      console.error('trip-change-publish-failed', {
        tripId: after.id,
        version: after.version,
        action,
        failureCount: failures.length,
      });
    }
    if (failures.length === 0) await this.clearProjection(after, action);
  }

  private async clearProjection(after: TripDocument, action: string): Promise<void> {
    const outbox = after.projectionOutbox?.filter(
      (entry) => !(entry.afterVersion === after.version && entry.action === action),
    );
    if (outbox === undefined || outbox.length === after.projectionOutbox?.length) return;
    await this.repository
      .replaceTrip({ ...after, projectionOutbox: outbox }, after.version)
      .catch(() => false);
  }
}

function appendOutbox(
  after: TripDocument,
  change: Pick<
    AuditLogDocument,
    'action' | 'actorUserId' | 'entityType' | 'entityId' | 'beforeVersion'
  > &
    Partial<Pick<NonNullable<TripDocument['projectionOutbox']>[number], 'notification'>>,
): TripDocument {
  const pending = after.projectionOutbox ?? [];
  if (pending.length >= LIMITS.projectionBacklogPerTrip) {
    throw new BusinessError(
      'PROJECTION_BACKLOG_LIMIT_REACHED',
      '同步修复任务积压，请稍后再修改行程。',
      true,
    );
  }
  const entry = {
    id: deterministicId('out', after.id, String(after.version), change.action),
    ...change,
    afterVersion: after.version,
    ledgerRevision: after.ledgerRevision,
    targetUserIds: after.members
      .filter((member) => member.viewState !== 'detached')
      .map((member) => member.userId),
    createdAt: after.updatedAt,
  };
  return { ...after, projectionOutbox: [...pending, entry] };
}

function notificationProjection(
  before: TripDocument,
  after: TripDocument,
  action: string,
  actorUserId: string,
): NonNullable<NonNullable<TripDocument['projectionOutbox']>[number]['notification']> | undefined {
  if (action === 'trip.completed' || action === 'trip.reopened') {
    const completed = action === 'trip.completed';
    return {
      type: completed ? 'trip_completed' : 'trip_reopened',
      title: completed ? '行程已完结' : '行程已重新开启',
      body: `“${after.name}”${completed ? '已完结' : '已重新开启'}`,
      targetUserIds: after.members
        .filter((member) => member.viewState !== 'detached')
        .map((member) => member.userId),
    };
  }
  if (action === 'member.joined' || action === 'member.left') {
    const joined = action === 'member.joined';
    const actor = (joined ? after : before).members.find((member) => member.userId === actorUserId);
    return {
      type: joined ? 'member_joined' : 'member_left',
      title: joined ? '新成员加入行程' : '成员退出行程',
      body: `${actor?.displayNameSnapshot ?? '一名成员'} 已${joined ? '加入' : '退出'}“${after.name}”`,
      targetUserIds: joined ? [...before.memberIds] : [...after.memberIds],
    };
  }
  return undefined;
}

function deterministicId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}
