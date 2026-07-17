import { createHash } from 'node:crypto';

import type { CloudCollection, CloudDatabase } from './cloud-repository';
import type {
  BlockDocument,
  FriendRequestDocument,
  FriendshipDocument,
  UserDocument,
} from './models';
import type { Repository } from './repository';
import type { SocialRepository } from './social-repository';

export interface SocialRelationshipTransition {
  block(
    blockerUserId: string,
    blockedUserId: string,
    createdAt: string,
  ): Promise<'saved' | 'user_inactive'>;
  deleteFriend(userId: string, friendUserId: string): Promise<void>;
}

export class CloudSocialRelationshipTransition implements SocialRelationshipTransition {
  constructor(private readonly db: CloudDatabase) {}

  async block(
    blockerUserId: string,
    blockedUserId: string,
    createdAt: string,
  ): Promise<'saved' | 'user_inactive'> {
    let outcome: 'saved' | 'user_inactive' = 'saved';
    await this.db.runTransaction(async (transaction) => {
      const [blocker, blocked] = await Promise.all([
        transaction.collection<UserDocument>('users').doc(blockerUserId).get(),
        transaction.collection<UserDocument>('users').doc(blockedUserId).get(),
      ]);
      if (blocker.data.status !== 'active' || blocked.data.status !== 'active') {
        outcome = 'user_inactive';
        return;
      }

      const friendships = await listAll(
        transaction.collection<FriendshipDocument>('friendships').where({ userIds: blockerUserId }),
      );
      const pairFriendships = friendships.filter((friendship) =>
        friendship.userIds.includes(blockedUserId),
      );
      const pendingRequests = await transaction
        .collection<FriendRequestDocument>('friend_requests')
        .where({ pendingKey: friendPendingKey(blockerUserId, blockedUserId) })
        .limit(1)
        .get();

      const block: BlockDocument = {
        id: blockId(blockerUserId, blockedUserId),
        blockerUserId,
        blockedUserId,
        createdAt,
      };
      for (const friendship of pairFriendships) {
        await transaction.collection<FriendshipDocument>('friendships').doc(friendship.id).remove();
      }
      const pending = pendingRequests.data[0];
      if (pending !== undefined && pending.status === 'pending') {
        await transaction
          .collection<FriendRequestDocument>('friend_requests')
          .doc(pending.id)
          .set({
            data: withoutDocumentId({
              ...pending,
              pendingKey: resolvedPendingKey(pending.id),
              status: 'rejected',
              respondedAt: createdAt,
            }),
          });
      }
      await transaction
        .collection<BlockDocument>('blocks')
        .doc(block.id)
        .set({ data: withoutDocumentId(block) });
    });
    return outcome;
  }

  async deleteFriend(userId: string, friendUserId: string): Promise<void> {
    await this.db.runTransaction(async (transaction) => {
      const friendships = await listAll(
        transaction.collection<FriendshipDocument>('friendships').where({ userIds: userId }),
      );
      for (const friendship of friendships) {
        if (friendship.userIds.includes(friendUserId)) {
          await transaction
            .collection<FriendshipDocument>('friendships')
            .doc(friendship.id)
            .remove();
        }
      }
    });
  }
}

export class MemorySocialRelationshipTransition implements SocialRelationshipTransition {
  constructor(
    private readonly repository: Repository,
    private readonly social: SocialRepository,
  ) {}

  async block(
    blockerUserId: string,
    blockedUserId: string,
    createdAt: string,
  ): Promise<'saved' | 'user_inactive'> {
    const [blocker, blocked] = await Promise.all([
      this.repository.getUser(blockerUserId),
      this.repository.getUser(blockedUserId),
    ]);
    if (blocker?.status !== 'active' || blocked?.status !== 'active') return 'user_inactive';
    const friendship = await this.social.getFriendship(blockerUserId, blockedUserId);
    if (friendship !== null) await this.social.deleteFriendship(friendship.id);
    const pending = await this.social.findPendingFriendRequest(blockerUserId, blockedUserId);
    if (pending !== null) {
      await this.social.updateFriendRequest({
        ...pending,
        pendingKey: resolvedPendingKey(pending.id),
        status: 'rejected',
        respondedAt: createdAt,
      });
    }
    if ((await this.social.getBlock(blockerUserId, blockedUserId)) === null) {
      await this.social.createBlock({
        id: blockId(blockerUserId, blockedUserId),
        blockerUserId,
        blockedUserId,
        createdAt,
      });
    }
    return 'saved';
  }

  async deleteFriend(userId: string, friendUserId: string): Promise<void> {
    const friendship = await this.social.getFriendship(userId, friendUserId);
    if (friendship !== null) await this.social.deleteFriendship(friendship.id);
  }
}

async function listAll<T>(collection: CloudCollection<T>): Promise<T[]> {
  const result: T[] = [];
  let offset = 0;
  while (true) {
    const page = await collection.skip(offset).limit(100).get();
    result.push(...page.data);
    if (page.data.length < 100) return result;
    offset += page.data.length;
  }
}

function friendPendingKey(first: string, second: string): string {
  const parts = [first, second].sort();
  return `friend_${createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 32)}`;
}

function blockId(blockerUserId: string, blockedUserId: string): string {
  const digest = createHash('sha256')
    .update(`${blockerUserId}:${blockedUserId}`)
    .digest('hex')
    .slice(0, 24);
  return `blk_${digest}`;
}

function resolvedPendingKey(recordId: string): string {
  return `resolved_${recordId}`;
}

function withoutDocumentId<T extends { id: string }>(value: T): T {
  const copy = { ...value } as T & { _id?: string };
  delete copy._id;
  return copy;
}
