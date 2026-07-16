import { cleanTrip, type MaintenanceBill, type MaintenanceMember } from './maintenance';
import {
  buildProjectionDocuments,
  type RepairProjection,
  type RepairTrip,
  type RepairUser,
} from './projection-repair';
import { cleanDeletedUserFiles, type DeletedUserFileRecord } from './deleted-user-cleanup';

interface DbCommand {
  lt(value: string): unknown;
}

interface QueryResult<T> {
  data: T[];
}

interface UpdateResult {
  stats?: { removed?: number; updated?: number };
}

export interface Collection<T> {
  add(options: { data: T }): Promise<unknown>;
  doc(id: string): {
    get(): Promise<{ data: T }>;
    set(options: { data: T }): Promise<unknown>;
  };
  get(): Promise<QueryResult<T>>;
  limit(value: number): Collection<T>;
  skip(value: number): Collection<T>;
  where(query: Record<string, unknown>): Collection<T>;
  remove(): Promise<UpdateResult>;
  update(options: { data: Partial<T> }): Promise<UpdateResult>;
}

export interface Database {
  collection<T>(name: string): Collection<T>;
  command: DbCommand;
}

export interface MaintenanceTripDocument extends RepairTrip {
  id: string;
  name: string;
  memberIds: readonly string[];
  members: readonly (MaintenanceMember & { userId: string })[];
  bills: readonly (MaintenanceBill & { id: string })[];
  ledgerRevision: number;
  settlementCache?: unknown;
  version: number;
  updatedAt: string;
  updatedBy: string;
}

interface ExpiringSocialDocument {
  id: string;
  expiresAt: string;
}

interface DeletedUserDocument extends DeletedUserFileRecord {
  status: string;
  updatedAt: string;
}

interface CloudSdk {
  DYNAMIC_CURRENT_ENV: symbol;
  database(): Database;
  deleteFile(options: { fileList: string[] }): Promise<unknown>;
  getWXContext(): { OPENID?: string };
  init(options: { env: symbol }): void;
}

export interface TripMaintenanceResult {
  orphanTripsRemoved: number;
  tripsUpdated: number;
  conflictsSkipped: number;
  projectionsRepaired: number;
  projectionFailures: number;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cloud = require('wx-server-sdk') as CloudSdk;
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

export async function main(): Promise<Record<string, number>> {
  const callerOpenId = cloud.getWXContext().OPENID;
  if (callerOpenId !== undefined && callerOpenId.length > 0) {
    throw new Error('maintenance function only accepts trusted trigger events');
  }
  const db = cloud.database();
  const now = new Date();
  const nowIso = now.toISOString();
  const summary = {
    expiredTokensRemoved: 0,
    expiredSocialRecordsRemoved: 0,
    oldSyncEventsRemoved: 0,
    oldAuditLogsRemoved: 0,
    orphanTripsRemoved: 0,
    tripsUpdated: 0,
    conflictsSkipped: 0,
    deletedUserFileCleanupFailures: 0,
    deletedUserFilesRemoved: 0,
    projectionsRepaired: 0,
    projectionFailures: 0,
  };

  for (const collection of ['idempotency_records', 'rate_limit_records']) {
    summary.expiredTokensRemoved += await removeExpired(db, collection, 'expiresAt', nowIso);
  }
  summary.expiredSocialRecordsRemoved += await purgeExpiredSocial(
    db,
    'friend_requests',
    'requestId',
    nowIso,
  );
  summary.expiredSocialRecordsRemoved += await purgeExpiredSocial(
    db,
    'trip_invitations',
    'invitationId',
    nowIso,
  );
  const syncCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  summary.oldSyncEventsRemoved += await removeExpired(db, 'sync_events', 'createdAt', syncCutoff);
  const auditCutoff = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000).toISOString();
  summary.oldAuditLogsRemoved += await removeExpired(db, 'audit_logs', 'createdAt', auditCutoff);
  const fileCleanup = await retryDeletedUserFileCleanup(db);
  summary.deletedUserFilesRemoved += fileCleanup.removed;
  summary.deletedUserFileCleanupFailures += fileCleanup.failed;

  const trips = await listAll(db.collection<MaintenanceTripDocument>('trips'));
  for (const trip of trips) {
    const tripResult = await maintainTrip(db, trip, now);
    summary.orphanTripsRemoved += tripResult.orphanTripsRemoved;
    summary.tripsUpdated += tripResult.tripsUpdated;
    summary.conflictsSkipped += tripResult.conflictsSkipped;
    summary.projectionsRepaired += tripResult.projectionsRepaired;
    summary.projectionFailures += tripResult.projectionFailures;
  }

  console.info('maintenance-complete', summary);
  return summary;
}

export async function maintainTrip(
  db: Database,
  listedTrip: MaintenanceTripDocument,
  now: Date,
): Promise<TripMaintenanceResult> {
  const result: TripMaintenanceResult = {
    orphanTripsRemoved: 0,
    tripsUpdated: 0,
    conflictsSkipped: 0,
    projectionsRepaired: 0,
    projectionFailures: 0,
  };
  const projectionSummary = await repairTripProjections(db, listedTrip);
  result.projectionsRepaired += projectionSummary.repaired;
  result.projectionFailures += projectionSummary.failed;

  // Projection repair may remove delivered entries. Always clean the latest persisted
  // document so a stale listing cannot put those entries back into the outbox.
  const currentTrip =
    (listedTrip.projectionOutbox?.length ?? 0) > 0
      ? (await db.collection<MaintenanceTripDocument>('trips').doc(listedTrip.id).get()).data
      : listedTrip;
  const cleaned = cleanTrip(currentTrip, now);
  if (!cleaned.changed && !cleaned.orphaned) return result;
  if (cleaned.orphaned) {
    const removed = await db
      .collection<MaintenanceTripDocument>('trips')
      .where({ _id: currentTrip.id, version: currentTrip.version })
      .remove();
    if (removed.stats?.removed === 1) {
      result.orphanTripsRemoved += 1;
      await purgeTripRelations(db, currentTrip.id);
    } else {
      result.conflictsSkipped += 1;
    }
    return result;
  }
  if ((currentTrip.projectionOutbox?.length ?? 0) >= 1000) {
    result.projectionFailures += 1;
    return result;
  }

  const nowIso = now.toISOString();
  const nextVersion = currentTrip.version + 1;
  const nextLedgerRevision = currentTrip.ledgerRevision + 1;
  const cleanupProjection: RepairProjection = {
    id: `out_maintenance_${currentTrip.id}_${nextVersion}`,
    action: 'trip.maintained',
    actorUserId: 'system:maintenance',
    entityType: 'trip',
    entityId: currentTrip.id,
    beforeVersion: currentTrip.version,
    afterVersion: nextVersion,
    ledgerRevision: nextLedgerRevision,
    targetUserIds: cleaned.members
      .filter((member) => member.viewState !== 'detached')
      .map((member) => member.userId),
    createdAt: nowIso,
  };
  const projectionOutbox = [...(currentTrip.projectionOutbox ?? []), cleanupProjection];
  const nextTrip: MaintenanceTripDocument = {
    ...currentTrip,
    bills: cleaned.bills,
    ledgerRevision: nextLedgerRevision,
    members: cleaned.members,
    projectionOutbox,
    settlementCache: null,
    version: nextVersion,
    updatedAt: nowIso,
    updatedBy: 'system:maintenance',
  };
  const updated = await db
    .collection<MaintenanceTripDocument>('trips')
    .where({ _id: currentTrip.id, version: currentTrip.version })
    .update({
      data: {
        bills: nextTrip.bills,
        ledgerRevision: nextTrip.ledgerRevision,
        members: nextTrip.members,
        projectionOutbox,
        settlementCache: null,
        version: nextTrip.version,
        updatedAt: nextTrip.updatedAt,
        updatedBy: nextTrip.updatedBy,
      },
    });
  if (updated.stats?.updated !== 1) {
    result.conflictsSkipped += 1;
    return result;
  }

  result.tripsUpdated += 1;
  const repaired = await repairTripProjections(db, nextTrip);
  result.projectionsRepaired += repaired.repaired;
  result.projectionFailures += repaired.failed;
  return result;
}

async function repairTripProjections(
  db: Database,
  trip: MaintenanceTripDocument,
): Promise<{ repaired: number; failed: number }> {
  const pending = trip.projectionOutbox ?? [];
  if (pending.length === 0) return { repaired: 0, failed: 0 };
  const userIds = [
    ...new Set(
      pending.flatMap((projection) => [
        ...projection.targetUserIds,
        ...(projection.notification?.targetUserIds ?? []),
      ]),
    ),
  ];
  const users = new Map<string, RepairUser>();
  for (const userId of userIds) {
    try {
      const user = await db.collection<RepairUser>('users').doc(userId).get();
      users.set(userId, user.data);
    } catch {
      // Missing users keep their outbox entry for manual review or later account repair.
    }
  }
  const retained = [];
  let repaired = 0;
  let failed = 0;
  for (const projection of pending) {
    const documents = buildProjectionDocuments(trip, projection, users);
    try {
      await createProjectionIfMissing(db, 'audit_logs', documents.auditLog);
      for (const event of documents.syncEvents) {
        await createProjectionIfMissing(db, 'sync_events', event);
      }
      for (const notification of documents.notifications) {
        await createProjectionIfMissing(db, 'notifications', notification);
      }
      if (documents.missingUserIds.length > 0) {
        retained.push(projection);
        failed += 1;
      } else {
        repaired += 1;
      }
    } catch {
      retained.push(projection);
      failed += 1;
    }
  }
  if (retained.length !== pending.length) {
    const updated = await db
      .collection<MaintenanceTripDocument>('trips')
      .where({ _id: trip.id, version: trip.version })
      .update({ data: { projectionOutbox: retained } });
    if (updated.stats?.updated !== 1) return { repaired: 0, failed: pending.length };
  }
  return { repaired, failed };
}

async function createProjectionIfMissing(
  db: Database,
  collectionName: string,
  document: Record<string, unknown>,
): Promise<void> {
  const id = String(document['_id']);
  const collection = db.collection<Record<string, unknown>>(collectionName);
  try {
    await collection.doc(id).get();
    return;
  } catch (error: unknown) {
    if (!isNotFoundError(error)) throw error;
  }
  try {
    await collection.add({ data: document });
  } catch (error: unknown) {
    try {
      await collection.doc(id).get();
      return;
    } catch {
      throw error;
    }
  }
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'errCode' in error ? String(error.errCode) : '';
  const message = 'message' in error ? String(error.message).toLowerCase() : '';
  return code.includes('DOCUMENT_NOT_FOUND') || message.includes('not found');
}

async function removeExpired(
  db: Database,
  collectionName: string,
  field: string,
  cutoff: string,
): Promise<number> {
  const result = await db
    .collection(collectionName)
    .where({ [field]: db.command.lt(cutoff) })
    .remove();
  return result.stats?.removed ?? 0;
}

async function purgeExpiredSocial(
  db: Database,
  collectionName: string,
  notificationField: 'requestId' | 'invitationId',
  cutoff: string,
): Promise<number> {
  let removed = 0;
  while (true) {
    const expired = await db
      .collection<ExpiringSocialDocument>(collectionName)
      .where({ expiresAt: db.command.lt(cutoff) })
      .limit(100)
      .get();
    if (expired.data.length === 0) return removed;
    for (const item of expired.data) {
      await db
        .collection('notifications')
        .where({ [notificationField]: item.id })
        .remove();
      const result = await db.collection(collectionName).where({ _id: item.id }).remove();
      removed += result.stats?.removed ?? 0;
    }
    if (expired.data.length < 100) return removed;
  }
}

async function listAll<T>(collection: Collection<T>): Promise<T[]> {
  const result: T[] = [];
  let offset = 0;
  while (true) {
    const page = await collection.skip(offset).limit(100).get();
    result.push(...page.data);
    if (page.data.length < 100) return result;
    offset += page.data.length;
  }
}

async function purgeTripRelations(db: Database, tripId: string): Promise<void> {
  await Promise.all([
    db.collection('audit_logs').where({ tripId }).remove(),
    db.collection('sync_events').where({ tripId }).remove(),
    db.collection('trip_invitations').where({ tripId }).remove(),
    db.collection('notifications').where({ tripId }).remove(),
  ]);
}

async function retryDeletedUserFileCleanup(
  db: Database,
): Promise<{ failed: number; removed: number }> {
  const users = await listAll(
    db.collection<DeletedUserDocument>('users').where({ status: 'deleted' }),
  );
  return cleanDeletedUserFiles(
    users,
    {
      deleteFiles: async (fileIds) => {
        await cloud.deleteFile({ fileList: [...fileIds] });
      },
      clearMarker: async (user, updatedAt) => {
        const updated = await db
          .collection<DeletedUserDocument>('users')
          .where({ _id: user.id, version: user.version })
          .update({
            data: {
              pendingFileDeletionIds: [],
              updatedAt,
              version: user.version + 1,
            },
          });
        return updated.stats?.updated === 1;
      },
    },
    new Date(),
  );
}
