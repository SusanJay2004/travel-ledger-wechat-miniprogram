import type { CloudCollection, CloudDatabase } from './cloud-repository';
import type {
  BlockDocument,
  AuditLogDocument,
  FriendRequestDocument,
  FriendshipDocument,
  NotificationDocument,
  SyncEventDocument,
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
      listAll(this.friendRequests().where({ fromUserId: userId })),
      listAll(this.friendRequests().where({ toUserId: userId })),
    ]);
    return deduplicate([...sent, ...received]);
  }

  async createFriendRequest(request: FriendRequestDocument) {
    try {
      await this.friendRequests().add({ data: withDocumentId(request) });
      return request;
    } catch (error: unknown) {
      if (!isDuplicateError(error) || request.pendingKey === undefined) throw error;
      const existing = await this.friendRequests()
        .where({ pendingKey: request.pendingKey })
        .limit(1)
        .get();
      if (existing.data[0] !== undefined) return withoutDocumentId(existing.data[0]);
      throw error;
    }
  }

  async expireFriendRequest(request: FriendRequestDocument, respondedAt: string) {
    const result = await this.friendRequests()
      .where({
        _id: request.id,
        status: 'pending',
        pendingKey: request.pendingKey,
        expiresAt: request.expiresAt,
      })
      .update({
        data: {
          pendingKey: `resolved_${request.id}`,
          status: 'expired',
          respondedAt,
        },
      });
    return result.stats?.updated === 1;
  }

  async updateFriendRequest(request: FriendRequestDocument) {
    await this.friendRequests()
      .doc(request.id)
      .set({ data: withDocumentId(request) });
  }

  async getFriendship(userA: string, userB: string) {
    const result = await listAll(this.friendships().where({ userIds: userA }));
    return result.find((friendship) => friendship.userIds.includes(userB)) ?? null;
  }

  async listFriendships(userId: string) {
    return listAll(this.friendships().where({ userIds: userId }));
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

  async getBlock(blockerUserId: string, blockedUserId: string) {
    const result = await this.blocks().where({ blockerUserId, blockedUserId }).limit(1).get();
    return result.data[0] ?? null;
  }

  async listBlocks(blockerUserId: string) {
    return listAll(this.blocks().where({ blockerUserId }));
  }

  async createBlock(block: BlockDocument) {
    await this.blocks().add({ data: withDocumentId(block) });
  }

  async deleteBlock(blockId: string) {
    await this.blocks().doc(blockId).remove();
  }

  async createNotification(notification: NotificationDocument) {
    if ((await this.getDocument(this.notifications(), notification.id)) !== null) return;
    try {
      await this.notifications().add({ data: withDocumentId(notification) });
    } catch (error: unknown) {
      if ((await this.getDocument(this.notifications(), notification.id)) !== null) return;
      throw error;
    }
  }

  async listNotifications(userId: string) {
    const result = await listAll(this.notifications().where({ userId }));
    return result.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
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

  async listInvitations(userId: string) {
    const [sent, received] = await Promise.all([
      listAll(this.invitations().where({ inviterUserId: userId })),
      listAll(this.invitations().where({ inviteeUserId: userId })),
    ]);
    return deduplicate([...sent, ...received]);
  }

  async createInvitation(invitation: TripInvitationDocument) {
    try {
      await this.invitations().add({ data: withDocumentId(invitation) });
      return invitation;
    } catch (error: unknown) {
      if (!isDuplicateError(error) || invitation.pendingKey === undefined) throw error;
      const existing = await this.invitations()
        .where({ pendingKey: invitation.pendingKey })
        .limit(1)
        .get();
      if (existing.data[0] !== undefined) return withoutDocumentId(existing.data[0]);
      throw error;
    }
  }

  async expireInvitation(invitation: TripInvitationDocument, respondedAt: string) {
    const result = await this.invitations()
      .where({
        _id: invitation.id,
        status: 'pending',
        pendingKey: invitation.pendingKey,
        expiresAt: invitation.expiresAt,
      })
      .update({
        data: {
          pendingKey: `resolved_${invitation.id}`,
          status: 'expired',
          respondedAt,
        },
      });
    return result.stats?.updated === 1;
  }

  async updateInvitation(invitation: TripInvitationDocument) {
    await this.invitations()
      .doc(invitation.id)
      .set({ data: withDocumentId(invitation) });
  }

  async createSyncEvent(event: SyncEventDocument) {
    await this.syncEvents()
      .doc(event.id)
      .set({ data: withDocumentId(event) });
  }

  async createAuditLog(log: AuditLogDocument) {
    await this.auditLogs()
      .doc(log.id)
      .set({ data: withDocumentId(log) });
  }

  async listAuditLogs(tripId: string) {
    const result = await listAll(this.auditLogs().where({ tripId }));
    return result.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async purgeUserData(userId: string) {
    // Delete explicit pages rather than relying on backend-dependent query-delete limits.
    // Running each scope sequentially also keeps a large account deletion below burst quotas.
    await removeAllMatching(this.friendRequests(), { fromUserId: userId });
    await removeAllMatching(this.friendRequests(), { toUserId: userId });
    await removeAllMatching(this.friendships(), { userIds: userId });
    await removeAllMatching(this.blocks(), { blockerUserId: userId });
    await removeAllMatching(this.blocks(), { blockedUserId: userId });
    await removeAllMatching(this.notifications(), { userId });
    await removeAllMatching(this.notifications(), { actorUserId: userId });
    await removeAllMatching(this.invitations(), { inviterUserId: userId });
    await removeAllMatching(this.invitations(), { inviteeUserId: userId });
    await removeAllMatching(this.syncEvents(), { userId });
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

  private syncEvents() {
    return this.db.collection<SyncEventDocument>('sync_events');
  }

  private auditLogs() {
    return this.db.collection<AuditLogDocument>('audit_logs');
  }
}

function withDocumentId<T extends { id: string }>(value: T): T & { _id: string } {
  return { ...value, _id: value.id };
}

function withoutDocumentId<T extends { id: string }>(value: T): T {
  const copy = { ...value } as T & { _id?: string };
  delete copy._id;
  return copy;
}

function deduplicate<T extends { id: string }>(items: readonly T[]): readonly T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

async function listAll<T>(collection: CloudCollection<T>): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  while (true) {
    const page = await collection.skip(offset).limit(100).get();
    items.push(...page.data);
    if (page.data.length < 100) return items;
    offset += page.data.length;
  }
}

async function removeAllMatching<T extends { id: string }>(
  collection: CloudCollection<T>,
  query: Record<string, unknown>,
): Promise<number> {
  let removed = 0;
  while (true) {
    const page = await collection.where(query).limit(20).get();
    if (page.data.length === 0) return removed;
    for (const document of page.data) await collection.doc(document.id).remove();
    removed += page.data.length;
  }
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const message = 'message' in error ? String(error.message) : '';
  const code = 'errCode' in error ? String(error.errCode) : '';
  return code.includes('DOCUMENT_NOT_FOUND') || message.toLowerCase().includes('not found');
}

function isDuplicateError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const message = 'message' in error ? String(error.message).toLowerCase() : '';
  const code = 'errCode' in error ? String(error.errCode).toLowerCase() : '';
  const value = `${code} ${message}`;
  return value.includes('duplicate') || value.includes('already exists') || value.includes('11000');
}
