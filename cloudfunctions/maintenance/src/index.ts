import { cleanTrip, type MaintenanceBill, type MaintenanceMember } from './maintenance';

interface DbCommand {
  lt(value: string): unknown;
}

interface QueryResult<T> {
  data: T[];
}

interface UpdateResult {
  stats?: { removed?: number; updated?: number };
}

interface Collection<T> {
  get(): Promise<QueryResult<T>>;
  limit(value: number): Collection<T>;
  skip(value: number): Collection<T>;
  where(query: Record<string, unknown>): Collection<T>;
  remove(): Promise<UpdateResult>;
  update(options: { data: Partial<T> }): Promise<UpdateResult>;
}

interface Database {
  collection<T>(name: string): Collection<T>;
  command: DbCommand;
}

interface MaintenanceTripDocument {
  id: string;
  memberIds: readonly string[];
  members: readonly (MaintenanceMember & { userId: string })[];
  bills: readonly (MaintenanceBill & { id: string })[];
  version: number;
  updatedAt: string;
  updatedBy: string;
}

interface ExpiringSocialDocument {
  id: string;
  expiresAt: string;
}

interface CloudSdk {
  DYNAMIC_CURRENT_ENV: symbol;
  database(): Database;
  getWXContext(): { OPENID?: string };
  init(options: { env: symbol }): void;
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
    orphanTripsRemoved: 0,
    tripsUpdated: 0,
    conflictsSkipped: 0,
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

  const trips = await listAll(db.collection<MaintenanceTripDocument>('trips'));
  for (const trip of trips) {
    const cleaned = cleanTrip(trip, now);
    if (!cleaned.changed && !cleaned.orphaned) continue;
    if (cleaned.orphaned) {
      const removed = await db
        .collection<MaintenanceTripDocument>('trips')
        .where({ _id: trip.id, version: trip.version })
        .remove();
      if (removed.stats?.removed === 1) {
        summary.orphanTripsRemoved += 1;
        await purgeTripRelations(db, trip.id);
      } else {
        summary.conflictsSkipped += 1;
      }
      continue;
    }
    const updated = await db
      .collection<MaintenanceTripDocument>('trips')
      .where({ _id: trip.id, version: trip.version })
      .update({
        data: {
          bills: cleaned.bills,
          members: cleaned.members,
          version: trip.version + 1,
          updatedAt: nowIso,
          updatedBy: 'system:maintenance',
        },
      });
    if (updated.stats?.updated === 1) summary.tripsUpdated += 1;
    else summary.conflictsSkipped += 1;
  }

  console.info('maintenance-complete', summary);
  return summary;
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
