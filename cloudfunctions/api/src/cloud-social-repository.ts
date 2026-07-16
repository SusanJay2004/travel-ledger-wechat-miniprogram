import type { CloudCollection, CloudDatabase } from './cloud-repository';
import type {
  BlockDocument,
  FriendRequestDocument,
  FriendshipDocument,
  NotificationDocument,
  TripInvitationDocument,
} from './models';
import type { SocialRepository } from './social-repository';

export class CloudSocialRepository implements SocialRepository {
  constructor(private readonly db: CloudDatabase) {}

  async getFriendRequest(requestId: string) {
    return this.getDocument(this.friendRequests(), requestId);
  }

  async findPendingFriendRequest(userA: string, userB: string) {
    const [forward, reverse] = await Promise.all([
      this.friendRequests()
        .where({ fromUserId: userA, toUserId: userB, status: 'pending' })
        .limit(1)
        .get(),
      this.friendRequests()
        .where({ fromUserId: userB, toUserId: userA, status: 'pending' })
        .limit(1)
        .get(),
    ]);
    return forward.data[0] ?? reverse.data[0] ?? null;
  }

  async listFriendRequests(userId: string) {
    const [sent, received] = await Promise.all([
      this.friendRequests().where({ fromUserId: userId }).limit(100).get(),
      this.friendRequests().where({ toUserId: userId }).limit(100).get(),
    ]);
    return deduplicate([...sent.data, ...received.data]);
  }

  async createFriendRequest(request: FriendRequestDocument) {
    await this.friendRequests().add({ data: withDocumentId(request) });
  }

  async updateFriendRequest(request: FriendRequestDocument) {
    await this.friendRequests()
      .doc(request.id)
      .set({ data: withDocumentId(request) });
  }

  async getFriendship(userA: string, userB: string) {
    const result = await this.friendships().where({ userIds: userA }).limit(100).get();
    return result.data.find((friendship) => friendship.userIds.includes(userB)) ?? null;
  }

  async listFriendships(userId: string) {
    return (await this.friendships().where({ userIds: userId }).limit(100).get()).data;
  }

  async createFriendship(friendship: FriendshipDocument) {
    await this.friendships().add({ data: withDocumentId(friendship) });
  }

  async deleteFriendship(friendshipId: string) {
    await this.friendships().doc(friendshipId).remove();
  }

  async isBlockedEither(userA: string, userB: string) {
    const [forward, reverse] = await Promise.all([
      this.blocks().where({ blockerUserId: userA, blockedUserId: userB }).limit(1).get(),
      this.blocks().where({ blockerUserId: userB, blockedUserId: userA }).limit(1).get(),
    ]);
    return forward.data.length > 0 || reverse.data.length > 0;
  }

  async createBlock(block: BlockDocument) {
    await this.blocks().add({ data: withDocumentId(block) });
  }

  async createNotification(notification: NotificationDocument) {
    await this.notifications().add({ data: withDocumentId(notification) });
  }

  async listNotifications(userId: string) {
    const result = await this.notifications().where({ userId }).limit(100).get();
    return result.data.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async markNotificationRead(notificationId: string, userId: string, readAt: string) {
    const notification = await this.getDocument(this.notifications(), notificationId);
    if (notification === null || notification.userId !== userId) return false;
    await this.notifications()
      .doc(notificationId)
      .set({ data: withDocumentId({ ...notification, readAt }) });
    return true;
  }

  async getInvitation(invitationId: string) {
    return this.getDocument(this.invitations(), invitationId);
  }

  async findPendingInvitation(tripId: string, inviteeUserId: string) {
    const result = await this.invitations()
      .where({ tripId, inviteeUserId, status: 'pending' })
      .limit(1)
      .get();
    return result.data[0] ?? null;
  }

  async createInvitation(invitation: TripInvitationDocument) {
    await this.invitations().add({ data: withDocumentId(invitation) });
  }

  async updateInvitation(invitation: TripInvitationDocument) {
    await this.invitations()
      .doc(invitation.id)
      .set({ data: withDocumentId(invitation) });
  }

  private async getDocument<T>(collection: CloudCollection<T>, id: string): Promise<T | null> {
    try {
      return (await collection.doc(id).get()).data;
    } catch (error: unknown) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  private friendRequests() {
    return this.db.collection<FriendRequestDocument>('friend_requests');
  }

  private friendships() {
    return this.db.collection<FriendshipDocument>('friendships');
  }

  private blocks() {
    return this.db.collection<BlockDocument>('blocks');
  }

  private notifications() {
    return this.db.collection<NotificationDocument>('notifications');
  }

  private invitations() {
    return this.db.collection<TripInvitationDocument>('trip_invitations');
  }
}

function withDocumentId<T extends { id: string }>(value: T): T & { _id: string } {
  return { ...value, _id: value.id };
}

function deduplicate<T extends { id: string }>(items: readonly T[]): readonly T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const message = 'message' in error ? String(error.message) : '';
  const code = 'errCode' in error ? String(error.errCode) : '';
  return code.includes('DOCUMENT_NOT_FOUND') || message.toLowerCase().includes('not found');
}
