import { redactedRuntimeError, safeDiagnosticCode } from '@travel-ledger/domain';

import { assertReviewPushSource, parseAvatarReviewEvent, type AvatarReviewEvent } from './review';

interface QueryResult<T> {
  data: T[];
}

interface UpdateResult {
  stats?: { updated?: number };
}

interface Collection<T> {
  get(): Promise<QueryResult<T>>;
  limit(value: number): Collection<T>;
  update(options: { data: Partial<T> }): Promise<UpdateResult>;
  where(query: Record<string, unknown>): Collection<T>;
}

interface Database {
  collection<T>(name: string): Collection<T>;
}

interface ReviewUser {
  id: string;
  avatarUrl: string | null;
  pendingAvatarFileId?: string | null;
  pendingAvatarReviewId?: string | null;
  pendingAvatarExpiresAt?: string | null;
  pendingFileDeletionIds?: readonly string[];
  status: string;
  updatedAt: string;
  version: number;
}

export interface CloudSdk {
  DYNAMIC_CURRENT_ENV: symbol;
  database(): Database;
  getWXContext(): { OPENID?: string; SOURCE?: string };
  init(options: { env: symbol }): void;
}

let initializedCloud: CloudSdk | null = null;

export async function main(event: AvatarReviewEvent): Promise<'success'> {
  return handleAvatarReviewInvocation(event, runtimeCloud);
}

export async function handleAvatarReviewInvocation(
  event: AvatarReviewEvent,
  cloudFactory: () => CloudSdk,
): Promise<'success'> {
  try {
    return await applyReviewEvent(event, cloudFactory());
  } catch (error: unknown) {
    console.error('avatar-review-failed', { errorCode: safeDiagnosticCode(error) });
    throw redactedRuntimeError(error, 'avatar review task failed');
  }
}

async function applyReviewEvent(event: AvatarReviewEvent, sdk: CloudSdk): Promise<'success'> {
  assertReviewPushSource(sdk.getWXContext().SOURCE);
  const review = parseAvatarReviewEvent(event);
  const db = sdk.database();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const outcome = await applyAvatarReview(db, review, new Date());
    if (outcome !== 'conflict') return 'success';
  }
  throw new Error('avatar review update conflicted repeatedly');
}

function runtimeCloud(): CloudSdk {
  if (initializedCloud !== null) return initializedCloud;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sdk = require('wx-server-sdk') as CloudSdk;
  sdk.init({ env: sdk.DYNAMIC_CURRENT_ENV });
  initializedCloud = sdk;
  return sdk;
}

export async function applyAvatarReview(
  db: Database,
  review: { accepted: boolean; label: number | null; traceId: string },
  now: Date,
): Promise<'applied' | 'ignored' | 'conflict'> {
  const candidates = await db
    .collection<ReviewUser>('users')
    .where({ pendingAvatarReviewId: review.traceId })
    .limit(2)
    .get();
  if (candidates.data.length !== 1) return 'ignored';
  const user = candidates.data[0]!;
  const candidate = user.pendingAvatarFileId;
  if (typeof candidate !== 'string' || candidate.length === 0) return 'ignored';
  const expiresAt = Date.parse(user.pendingAvatarExpiresAt ?? '');
  const accepted =
    review.accepted &&
    user.status === 'active' &&
    Number.isFinite(expiresAt) &&
    expiresAt > now.getTime();
  const nextAvatar = accepted ? candidate : user.avatarUrl;
  const pendingFileDeletionIds = uniqueFileIds(user.pendingFileDeletionIds, [
    ...(accepted ? [user.avatarUrl] : []),
    ...(accepted ? [] : [candidate]),
  ]).filter((fileId) => fileId !== nextAvatar);
  const updated = await db
    .collection<ReviewUser>('users')
    .where({
      _id: user.id,
      version: user.version,
      pendingAvatarReviewId: review.traceId,
    })
    .update({
      data: {
        avatarUrl: nextAvatar,
        pendingAvatarFileId: null,
        pendingAvatarReviewId: null,
        pendingAvatarExpiresAt: null,
        pendingFileDeletionIds,
        updatedAt: now.toISOString(),
        version: user.version + 1,
      },
    });
  if (updated.stats?.updated !== 1) return 'conflict';
  console.info('avatar-review-applied', { accepted, label: review.label });
  return 'applied';
}

function uniqueFileIds(
  existing: readonly string[] | undefined,
  candidates: readonly (string | null | undefined)[],
): readonly string[] {
  return [...new Set([...(existing ?? []), ...candidates])].filter(
    (value): value is string => typeof value === 'string' && value.startsWith('cloud://'),
  );
}
