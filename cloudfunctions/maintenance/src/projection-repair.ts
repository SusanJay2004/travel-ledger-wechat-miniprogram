import { createHash } from 'node:crypto';

export interface RepairUser {
  id: string;
  openId: string;
  status: string;
}

export interface RepairNotification {
  type: string;
  title: string;
  body: string;
  targetUserIds: readonly string[];
}

export interface RepairProjection {
  id: string;
  action: string;
  actorUserId: string;
  entityType: 'trip' | 'date' | 'bill' | 'member';
  entityId: string;
  beforeVersion: number;
  afterVersion: number;
  ledgerRevision: number;
  targetUserIds: readonly string[];
  notification?: RepairNotification;
  createdAt: string;
}

export interface RepairTrip {
  id: string;
  name: string;
  version: number;
  projectionOutbox?: readonly RepairProjection[];
}

export interface ProjectionDocuments {
  auditLog: Record<string, unknown>;
  syncEvents: readonly Record<string, unknown>[];
  notifications: readonly Record<string, unknown>[];
  missingUserIds: readonly string[];
}

export function buildProjectionDocuments(
  trip: RepairTrip,
  projection: RepairProjection,
  users: ReadonlyMap<string, RepairUser>,
): ProjectionDocuments {
  const missingUserIds: string[] = [];
  const syncEvents = projection.targetUserIds.flatMap((userId) => {
    const user = users.get(userId);
    if (user === undefined) {
      missingUserIds.push(userId);
      return [];
    }
    if (user.status !== 'active') return [];
    return [
      {
        _id: deterministicId(
          'syn',
          trip.id,
          String(projection.afterVersion),
          projection.action,
          userId,
        ),
        id: deterministicId(
          'syn',
          trip.id,
          String(projection.afterVersion),
          projection.action,
          userId,
        ),
        userId,
        tripId: trip.id,
        ledgerRevision: projection.ledgerRevision,
        action: projection.action,
        actorUserId: projection.actorUserId,
        createdAt: projection.createdAt,
      },
    ];
  });
  const notifications = (projection.notification?.targetUserIds ?? []).flatMap((userId) => {
    const user = users.get(userId);
    if (user === undefined) {
      if (!missingUserIds.includes(userId)) missingUserIds.push(userId);
      return [];
    }
    if (user.status !== 'active') return [];
    const id = deterministicId(
      'not',
      trip.id,
      String(projection.afterVersion),
      projection.action,
      userId,
    );
    return [
      {
        _id: id,
        id,
        userId,
        type: projection.notification!.type,
        actorUserId: projection.actorUserId,
        tripId: trip.id,
        requestId: null,
        invitationId: null,
        title: projection.notification!.title,
        body: projection.notification!.body,
        readAt: null,
        createdAt: projection.createdAt,
      },
    ];
  });
  const auditId = deterministicId(
    'aud',
    trip.id,
    String(projection.afterVersion),
    projection.action,
  );
  return {
    auditLog: {
      _id: auditId,
      id: auditId,
      tripId: trip.id,
      actorUserId: projection.actorUserId,
      action: projection.action,
      entityType: projection.entityType,
      entityId: projection.entityId,
      beforeVersion: projection.beforeVersion,
      afterVersion: projection.afterVersion,
      createdAt: projection.createdAt,
    },
    syncEvents,
    notifications,
    missingUserIds,
  };
}

function deterministicId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}
