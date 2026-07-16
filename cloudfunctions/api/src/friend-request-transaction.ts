import { createHash } from 'node:crypto';

import type { CloudCollection, CloudDatabase } from './cloud-repository';
import type { FriendRequestDocument, FriendshipDocument, UserDocument } from './models';
import type { Repository } from './repository';
import type { SocialRepository } from './social-repository';

export type FriendRequestTransitionOutcome =
  'saved' | 'request_conflict' | 'request_expired' | 'authorization_changed' | 'user_inactive';

export interface FriendRequestTransitionInput {
  request: FriendRequestDocument;
}

export interface FriendRequestTransition {
  commit(input: FriendRequestTransitionInput): Promise<FriendRequestTransitionOutcome>;
}

export class CloudFriendRequestTransition implements FriendRequestTransition {
  constructor(private readonly db: CloudDatabase) {}

  async commit(input: FriendRequestTransitionInput): Promise<FriendRequestTransitionOutcome> {
    let outcome: FriendRequestTransitionOutcome = 'request_conflict';
    await this.db.runTransaction(async (transaction) => {
      const requestReference = transaction
        .collection<FriendRequestDocument>('friend_requests')
        .doc(input.request.id);
      const current = (await requestReference.get()).data;
      if (
        current.status !== 'pending' ||
        current.fromUserId !== input.request.fromUserId ||
        current.toUserId !== input.request.toUserId
      ) {
        outcome = 'request_conflict';
        return;
      }
      if (input.request.respondedAt === null || current.expiresAt <= input.request.respondedAt) {
        outcome = 'request_expired';
        return;
      }

      const [fromUser, toUser] = await Promise.all([
        transaction.collection<UserDocument>('users').doc(current.fromUserId).get(),
        transaction.collection<UserDocument>('users').doc(current.toUserId).get(),
      ]);
      if (fromUser.data.status !== 'active' || toUser.data.status !== 'active') {
        outcome = 'user_inactive';
        return;
      }
      const [forwardBlock, reverseBlock] = await Promise.all([
        transaction
          .collection('blocks')
          .where({ blockerUserId: current.fromUserId, blockedUserId: current.toUserId })
          .limit(1)
          .get(),
        transaction
          .collection('blocks')
          .where({ blockerUserId: current.toUserId, blockedUserId: current.fromUserId })
          .limit(1)
          .get(),
      ]);
      if (forwardBlock.data.length > 0 || reverseBlock.data.length > 0) {
        outcome = 'authorization_changed';
        return;
      }

      if (input.request.status === 'accepted') {
        const friendships = await listAll(
          transaction
            .collection<FriendshipDocument>('friendships')
            .where({ userIds: current.fromUserId }),
        );
        const exists = friendships.some((friendship) =>
          friendship.userIds.includes(current.toUserId),
        );
        if (!exists) {
          const userIds = [current.fromUserId, current.toUserId].sort() as [string, string];
          const friendship: FriendshipDocument = {
            id: friendshipId(userIds),
            userIds,
            createdAt: input.request.respondedAt,
          };
          await transaction
            .collection<FriendshipDocument>('friendships')
            .doc(friendship.id)
            .set({ data: withoutDocumentId(friendship) });
        }
      }

      outcome = 'saved';
      await requestReference.set({ data: withoutDocumentId(input.request) });
    });
    return outcome;
  }
}

export class MemoryFriendRequestTransition implements FriendRequestTransition {
  constructor(
    private readonly repository: Repository,
    private readonly social: SocialRepository,
  ) {}

  async commit(input: FriendRequestTransitionInput): Promise<FriendRequestTransitionOutcome> {
    const current = await this.social.getFriendRequest(input.request.id);
    if (
      current === null ||
      current.status !== 'pending' ||
      current.fromUserId !== input.request.fromUserId ||
      current.toUserId !== input.request.toUserId
    ) {
      return 'request_conflict';
    }
    if (input.request.respondedAt === null || current.expiresAt <= input.request.respondedAt) {
      return 'request_expired';
    }
    const [fromUser, toUser] = await Promise.all([
      this.repository.getUser(current.fromUserId),
      this.repository.getUser(current.toUserId),
    ]);
    if (fromUser?.status !== 'active' || toUser?.status !== 'active') return 'user_inactive';
    if (await this.social.isBlockedEither(current.fromUserId, current.toUserId)) {
      return 'authorization_changed';
    }
    if (
      input.request.status === 'accepted' &&
      (await this.social.getFriendship(current.fromUserId, current.toUserId)) === null
    ) {
      const userIds = [current.fromUserId, current.toUserId].sort() as [string, string];
      await this.social.createFriendship({
        id: friendshipId(userIds),
        userIds,
        createdAt: input.request.respondedAt,
      });
    }
    await this.social.updateFriendRequest(input.request);
    return 'saved';
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

function friendshipId(userIds: readonly [string, string]): string {
  const digest = createHash('sha256').update(userIds.join(':')).digest('hex').slice(0, 24);
  return `fri_${digest}`;
}

function withoutDocumentId<T extends { id: string }>(value: T): T {
  const copy = { ...value } as T & { _id?: string };
  delete copy._id;
  return copy;
}
