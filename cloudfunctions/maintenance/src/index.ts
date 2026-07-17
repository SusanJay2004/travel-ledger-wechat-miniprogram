import { createHash } from 'node:crypto';

import { cleanTrip, type MaintenanceBill, type MaintenanceMember } from './maintenance';
import {
  buildProjectionDocuments,
  type RepairProjection,
  type RepairTrip,
  type RepairUser,
} from './projection-repair';
import { cleanDeletedUserFiles, type DeletedUserFileRecord } from './deleted-user-cleanup';
import { assertScheduledTrigger, type TriggerContext } from './trigger-auth';
import { deleteFilesCompletely, type DeleteFileResultItem } from './file-deletion';

interface DbCommand {
  gt(value: string): unknown;
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
  orderBy(field: string, direction: 'asc' | 'desc'): Collection<T>;
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
  members: readonly (MaintenanceMember & { userId: string; displayNameSnapshot?: string })[];
  bills: readonly (Record<string, unknown> &
    MaintenanceBill & {
      id: string;
      participants?: readonly (Record<string, unknown> & {
        memberId: string;
        displayName: string;
      })[];
      payers?: readonly (Record<string, unknown> & {
        memberId: string;
        displayName: string;
      })[];
    })[];
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
  avatarUrl?: string | null;
  homeTripCount?: number;
  openId?: string;
  pendingAvatarExpiresAt?: string | null;
  pendingAvatarFileId?: string | null;
  pendingAvatarReviewId?: string | null;
  pendingFileDeletionIds?: readonly string[];
  publicId?: string;
  qrCodeFileId?: string | null;
  stagedAvatarExpiresAt?: string | null;
  stagedAvatarFileId?: string | null;
  stagedAvatarToken?: string | null;
  stagedAvatarSha256?: string | null;
  stagedAvatarSize?: number | null;
  status: string;
  updatedAt: string;
}

export interface AccountDeletionMaintenanceResult {
  completed: number;
  conflicts: number;
  tripsUpdated: number;
}

interface CloudSdk {
  DYNAMIC_CURRENT_ENV: symbol;
  database(): Database;
  deleteFile(options: { fileList: string[] }): Promise<{
    fileList: readonly DeleteFileResultItem[];
  }>;
  getWXContext(): TriggerContext;
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
  assertScheduledTrigger(cloud.getWXContext());
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
    accountDeletionsCompleted: 0,
    accountDeletionConflicts: 0,
    accountDeletionTripsUpdated: 0,
    expiredAvatarReviewsRemoved: 0,
    expiredStagedAvatarsRemoved: 0,
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
  summary.expiredAvatarReviewsRemoved += await expireAvatarReviews(db, nowIso);
  summary.expiredStagedAvatarsRemoved += await expireStagedAvatars(db, nowIso);
  const fileCleanup = await retryDeletedUserFileCleanup(db);
  summary.deletedUserFilesRemoved += fileCleanup.removed;
  summary.deletedUserFileCleanupFailures += fileCleanup.failed;
  const accountDeletion = await resumeDeletingAccounts(db, now);
  summary.accountDeletionsCompleted += accountDeletion.completed;
  summary.accountDeletionConflicts += accountDeletion.conflicts;
  summary.accountDeletionTripsUpdated += accountDeletion.tripsUpdated;

  await visitDocumentsById<MaintenanceTripDocument>(db, 'trips', {}, async (trips) => {
    for (const trip of trips) {
      const tripResult = await maintainTrip(db, trip, now);
      summary.orphanTripsRemoved += tripResult.orphanTripsRemoved;
      summary.tripsUpdated += tripResult.tripsUpdated;
      summary.conflictsSkipped += tripResult.conflictsSkipped;
      summary.projectionsRepaired += tripResult.projectionsRepaired;
      summary.projectionFailures += tripResult.projectionFailures;
    }
  });

  console.info('maintenance-complete', summary);
  return summary;
}

export async function resumeDeletingAccounts(
  db: Database,
  now: Date,
): Promise<AccountDeletionMaintenanceResult> {
  const total: AccountDeletionMaintenanceResult = { completed: 0, conflicts: 0, tripsUpdated: 0 };
  await visitDocumentsById<DeletedUserDocument>(
    db,
    'users',
    { status: 'deleting' },
    async (users) => {
      for (const user of users) {
        const result = await resumeDeletingAccount(db, user, now);
        total.completed += result.completed;
        total.conflicts += result.conflicts;
        total.tripsUpdated += result.tripsUpdated;
      }
    },
  );
  return total;
}

async function resumeDeletingAccount(
  db: Database,
  user: DeletedUserDocument,
  now: Date,
): Promise<AccountDeletionMaintenanceResult> {
  const result: AccountDeletionMaintenanceResult = { completed: 0, conflicts: 0, tripsUpdated: 0 };
  const nowIso = now.toISOString();
  await visitDocumentsById<MaintenanceTripDocument>(
    db,
    'trips',
    { memberIds: user.id },
    async (trips) => {
      for (const trip of trips) {
        const member = trip.members.find((item) => item.userId === user.id);
        if (member?.viewState === 'detached' && member.displayNameSnapshot === '已注销用户') {
          continue;
        }
        if (member === undefined || (trip.projectionOutbox?.length ?? 0) >= 1000) {
          result.conflicts += 1;
          continue;
        }
        const nextVersion = trip.version + 1;
        const nextLedgerRevision = trip.ledgerRevision + 1;
        const members = trip.members.map((item) =>
          item.userId === user.id
            ? {
                ...item,
                displayNameSnapshot: '已注销用户',
                viewState: 'detached' as const,
                archivedAt: null,
                purgeAfter: null,
              }
            : item,
        );
        const bills = trip.bills.map((bill) => ({
          ...bill,
          ...(bill.participants === undefined
            ? {}
            : {
                participants: bill.participants.map((participant) =>
                  participant.memberId === user.id
                    ? { ...participant, displayName: '已注销用户' }
                    : participant,
                ),
              }),
          ...(bill.payers === undefined
            ? {}
            : {
                payers: bill.payers.map((payer) =>
                  payer.memberId === user.id ? { ...payer, displayName: '已注销用户' } : payer,
                ),
              }),
        }));
        const projection: RepairProjection = {
          id: deterministicMaintenanceId(
            'out',
            trip.id,
            String(nextVersion),
            'member.account_deleted',
          ),
          action: 'member.account_deleted',
          actorUserId: user.id,
          entityType: 'member',
          entityId: user.id,
          beforeVersion: trip.version,
          afterVersion: nextVersion,
          ledgerRevision: nextLedgerRevision,
          targetUserIds: members
            .filter((item) => item.viewState !== 'detached')
            .map((item) => item.userId),
          createdAt: nowIso,
        };
        const updated = await db
          .collection<MaintenanceTripDocument>('trips')
          .where({ _id: trip.id, version: trip.version })
          .update({
            data: {
              members,
              bills,
              ledgerRevision: nextLedgerRevision,
              projectionOutbox: [...(trip.projectionOutbox ?? []), projection],
              settlementCache: null,
              version: nextVersion,
              updatedAt: nowIso,
              updatedBy: user.id,
            },
          });
        if (updated.stats?.updated === 1) result.tripsUpdated += 1;
        else result.conflicts += 1;
      }
    },
  );
  if (result.conflicts > 0) return result;

  await purgeUserSocialData(db, user.id);
  const finalized = await db
    .collection<DeletedUserDocument>('users')
    .where({ _id: user.id, version: user.version, status: 'deleting' })
    .update({
      data: {
        openId: `deleted:${user.id}`,
        publicId: `deleted:${user.id}`,
        homeTripCount: 0,
        status: 'deleted',
        updatedAt: nowIso,
        version: user.version + 1,
      },
    });
  if (finalized.stats?.updated === 1) result.completed += 1;
  else result.conflicts += 1;
  return result;
}

export async function expireAvatarReviews(db: Database, nowIso: string): Promise<number> {
  let expired = 0;
  await visitDocumentsById<DeletedUserDocument>(
    db,
    'users',
    { pendingAvatarExpiresAt: db.command.lt(nowIso) },
    async (users) => {
      for (const user of users) {
        const candidate = user.pendingAvatarFileId;
        if (
          typeof candidate !== 'string' ||
          typeof user.pendingAvatarReviewId !== 'string' ||
          typeof user.pendingAvatarExpiresAt !== 'string'
        ) {
          continue;
        }
        const pendingFileDeletionIds = [
          ...new Set([...(user.pendingFileDeletionIds ?? []), candidate]),
        ];
        const updated = await db
          .collection<DeletedUserDocument>('users')
          .where({
            _id: user.id,
            version: user.version,
            pendingAvatarReviewId: user.pendingAvatarReviewId,
            pendingAvatarExpiresAt: user.pendingAvatarExpiresAt,
          })
          .update({
            data: {
              pendingAvatarFileId: null,
              pendingAvatarReviewId: null,
              pendingAvatarExpiresAt: null,
              pendingFileDeletionIds,
              updatedAt: nowIso,
              version: user.version + 1,
            },
          });
        if (updated.stats?.updated === 1) expired += 1;
      }
    },
  );
  return expired;
}

export async function expireStagedAvatars(db: Database, nowIso: string): Promise<number> {
  let expired = 0;
  await visitDocumentsById<DeletedUserDocument>(
    db,
    'users',
    { stagedAvatarExpiresAt: db.command.lt(nowIso) },
    async (users) => {
      for (const user of users) {
        const candidate = user.stagedAvatarFileId;
        if (
          typeof candidate !== 'string' ||
          typeof user.stagedAvatarToken !== 'string' ||
          typeof user.stagedAvatarExpiresAt !== 'string'
        ) {
          continue;
        }
        const pendingFileDeletionIds = [
          ...new Set([...(user.pendingFileDeletionIds ?? []), candidate]),
        ];
        const updated = await db
          .collection<DeletedUserDocument>('users')
          .where({
            _id: user.id,
            version: user.version,
            stagedAvatarToken: user.stagedAvatarToken,
            stagedAvatarExpiresAt: user.stagedAvatarExpiresAt,
          })
          .update({
            data: {
              stagedAvatarFileId: null,
              stagedAvatarToken: null,
              stagedAvatarExpiresAt: null,
              stagedAvatarSha256: null,
              stagedAvatarSize: null,
              pendingFileDeletionIds,
              updatedAt: nowIso,
              version: user.version + 1,
            },
          });
        if (updated.stats?.updated === 1) expired += 1;
      }
    },
  );
  return expired;
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
    // No current member can legitimately mutate a fully detached trip. Remove its
    // relations first so a partial failure leaves the trip discoverable for retry.
    await purgeTripRelations(db, currentTrip.id);
    const removed = await db
      .collection<MaintenanceTripDocument>('trips')
      .where({ _id: currentTrip.id, version: currentTrip.version })
      .remove();
    if (removed.stats?.removed === 1) {
      result.orphanTripsRemoved += 1;
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
  return removeAllMatching(db, collectionName, { [field]: db.command.lt(cutoff) });
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

export async function visitDocumentsById<T extends { id: string }>(
  db: Database,
  collectionName: string,
  filter: Record<string, unknown>,
  visit: (documents: readonly T[]) => Promise<void>,
): Promise<void> {
  let cursor: string | null = null;
  while (true) {
    const query: Record<string, unknown> =
      cursor === null ? filter : { ...filter, _id: db.command.gt(cursor) };
    const page: QueryResult<T> = await db
      .collection<T>(collectionName)
      .where(query)
      .orderBy('_id', 'asc')
      .limit(100)
      .get();
    if (page.data.length === 0) return;
    const lastId: string | undefined = page.data.at(-1)?.id;
    if (typeof lastId !== 'string' || lastId.length === 0) {
      throw new Error('maintenance document is missing a stable id cursor');
    }
    await visit(page.data);
    cursor = lastId;
    if (page.data.length < 100) return;
  }
}

async function purgeTripRelations(db: Database, tripId: string): Promise<void> {
  await Promise.all([
    removeAllMatching(db, 'audit_logs', { tripId }),
    removeAllMatching(db, 'sync_events', { tripId }),
    removeAllMatching(db, 'trip_invitations', { tripId }),
    removeAllMatching(db, 'notifications', { tripId }),
  ]);
}

async function purgeUserSocialData(db: Database, userId: string): Promise<void> {
  const scopes: readonly [string, Record<string, unknown>][] = [
    ['friend_requests', { fromUserId: userId }],
    ['friend_requests', { toUserId: userId }],
    ['friendships', { userIds: userId }],
    ['blocks', { blockerUserId: userId }],
    ['blocks', { blockedUserId: userId }],
    ['notifications', { userId }],
    ['notifications', { actorUserId: userId }],
    ['trip_invitations', { inviterUserId: userId }],
    ['trip_invitations', { inviteeUserId: userId }],
    ['sync_events', { userId }],
  ];
  for (const [collectionName, query] of scopes) {
    await removeAllMatching(db, collectionName, query);
  }
}

async function removeAllMatching(
  db: Database,
  collectionName: string,
  query: Record<string, unknown>,
): Promise<number> {
  let removed = 0;
  while (true) {
    const result = await db.collection(collectionName).where(query).remove();
    const count = result.stats?.removed ?? 0;
    removed += count;
    if (count === 0) return removed;
  }
}

async function retryDeletedUserFileCleanup(
  db: Database,
): Promise<{ failed: number; removed: number }> {
  const total = { failed: 0, removed: 0 };
  await visitDocumentsById<DeletedUserDocument>(db, 'users', {}, async (users) => {
    const page = await cleanDeletedUserFiles(
      users,
      {
        deleteFiles: async (fileIds) => {
          await deleteFilesCompletely(cloud, fileIds);
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
    total.failed += page.failed;
    total.removed += page.removed;
  });
  return total;
}

function deterministicMaintenanceId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}
