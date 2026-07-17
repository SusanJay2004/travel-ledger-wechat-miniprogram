import { createHash } from 'node:crypto';

import type { CloudDatabase } from './cloud-repository';
import { BusinessError } from './errors';
import type { Clock, RateLimitRecordDocument } from './models';

interface Policy {
  limit: number;
  scope: string;
  windowMs: number;
}

interface CloudError {
  errCode?: string | number;
  message?: string;
}

export class RateLimiter {
  constructor(
    private readonly db: CloudDatabase,
    private readonly clock: Clock,
  ) {}

  async consume(ownerOpenId: string, requestId: string, action: string): Promise<void> {
    const policy = policyFor(action);
    const now = this.clock.now();
    const ownerHash = hash(ownerOpenId);
    const bucket = String(Math.floor(now.getTime() / policy.windowMs));
    const id = hash(`${ownerHash}:${policy.scope}:${bucket}`);
    await this.db.runTransaction(async (transaction) => {
      const reference = transaction
        .collection<RateLimitRecordDocument>('rate_limit_records')
        .doc(id);
      let current: RateLimitRecordDocument | null = null;
      try {
        current = (await reference.get()).data;
      } catch (error: unknown) {
        if (!isNotFound(error)) throw error;
      }
      if (current?.requestIds.includes(requestId) === true) return;
      if ((current?.requestIds.length ?? 0) >= policy.limit) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((policy.windowMs - (now.getTime() % policy.windowMs)) / 1000),
        );
        throw new BusinessError('RATE_LIMITED', '操作太频繁，请稍后再试。', true, {
          retryAfterSeconds,
        });
      }
      const record: RateLimitRecordDocument = {
        id,
        ownerHash,
        requestIds: [...(current?.requestIds ?? []), requestId],
        scope: policy.scope,
        bucket,
        createdAt: current?.createdAt ?? now.toISOString(),
        expiresAt: new Date(
          now.getTime() + Math.max(policy.windowMs * 2, 2 * 60 * 60 * 1000),
        ).toISOString(),
      };
      await reference.set({ data: record });
    });
  }
}

function policyFor(action: string): Policy {
  if (action === 'session.deleteAccount') {
    return { limit: 3, scope: action, windowMs: 24 * 60 * 60 * 1000 };
  }
  if (action === 'session.qrCode') {
    return { limit: 5, scope: action, windowMs: 60 * 60 * 1000 };
  }
  if (action === 'social.sendFriendRequest' || action === 'social.inviteToTrip') {
    return { limit: 20, scope: action, windowMs: 60 * 60 * 1000 };
  }
  if (action === 'social.search') {
    return { limit: 30, scope: action, windowMs: 60 * 1000 };
  }
  if (isMutation(action)) {
    return { limit: 60, scope: 'write', windowMs: 60 * 1000 };
  }
  return { limit: 180, scope: 'read', windowMs: 60 * 1000 };
}

function isMutation(action: string): boolean {
  const tripWrite =
    action.startsWith('trip.') &&
    !['trip.list', 'trip.listArchived', 'trip.get', 'trip.activity', 'trip.calculate'].includes(
      action,
    );
  const socialWrite =
    action.startsWith('social.') &&
    ![
      'social.search',
      'social.listFriends',
      'social.listBlocked',
      'social.listNotifications',
    ].includes(action);
  return action.startsWith('session.update') || tripWrite || socialWrite;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as CloudError;
  return (
    String(candidate.errCode ?? '').includes('DOCUMENT_NOT_FOUND') ||
    String(candidate.message ?? '')
      .toLowerCase()
      .includes('not found')
  );
}
