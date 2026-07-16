import type {
  BlockDocument,
  FriendRequestDocument,
  FriendshipDocument,
  NotificationDocument,
  TripInvitationDocument,
} from './models';

export interface SocialRepository {
  getFriendRequest(requestId: string): Promise<FriendRequestDocument | null>;
  findPendingFriendRequest(userA: string, userB: string): Promise<FriendRequestDocument | null>;
  listFriendRequests(userId: string): Promise<readonly FriendRequestDocument[]>;
  createFriendRequest(request: FriendRequestDocument): Promise<void>;
  updateFriendRequest(request: FriendRequestDocument): Promise<void>;

  getFriendship(userA: string, userB: string): Promise<FriendshipDocument | null>;
  listFriendships(userId: string): Promise<readonly FriendshipDocument[]>;
  createFriendship(friendship: FriendshipDocument): Promise<void>;
  deleteFriendship(friendshipId: string): Promise<void>;

  isBlockedEither(userA: string, userB: string): Promise<boolean>;
  createBlock(block: BlockDocument): Promise<void>;

  createNotification(notification: NotificationDocument): Promise<void>;
  listNotifications(userId: string): Promise<readonly NotificationDocument[]>;
  markNotificationRead(notificationId: string, userId: string, readAt: string): Promise<boolean>;

  getInvitation(invitationId: string): Promise<TripInvitationDocument | null>;
  findPendingInvitation(
    tripId: string,
    inviteeUserId: string,
  ): Promise<TripInvitationDocument | null>;
  createInvitation(invitation: TripInvitationDocument): Promise<void>;
  updateInvitation(invitation: TripInvitationDocument): Promise<void>;
}

export class MemorySocialRepository implements SocialRepository {
  private readonly friendRequests = new Map<string, FriendRequestDocument>();
  private readonly friendships = new Map<string, FriendshipDocument>();
  private readonly blocks = new Map<string, BlockDocument>();
  private readonly notifications = new Map<string, NotificationDocument>();
  private readonly invitations = new Map<string, TripInvitationDocument>();

  async getFriendRequest(requestId: string) {
    return cloneOrNull(this.friendRequests.get(requestId));
  }

  async findPendingFriendRequest(userA: string, userB: string) {
    const item = [...this.friendRequests.values()].find(
      (request) =>
        request.status === 'pending' &&
        ((request.fromUserId === userA && request.toUserId === userB) ||
          (request.fromUserId === userB && request.toUserId === userA)),
    );
    return cloneOrNull(item);
  }

  async listFriendRequests(userId: string) {
    return [...this.friendRequests.values()]
      .filter((request) => request.fromUserId === userId || request.toUserId === userId)
      .map((request) => structuredClone(request));
  }

  async createFriendRequest(request: FriendRequestDocument) {
    this.friendRequests.set(request.id, structuredClone(request));
  }

  async updateFriendRequest(request: FriendRequestDocument) {
    this.friendRequests.set(request.id, structuredClone(request));
  }

  async getFriendship(userA: string, userB: string) {
    const item = [...this.friendships.values()].find(
      (friendship) => friendship.userIds.includes(userA) && friendship.userIds.includes(userB),
    );
    return cloneOrNull(item);
  }

  async listFriendships(userId: string) {
    return [...this.friendships.values()]
      .filter((friendship) => friendship.userIds.includes(userId))
      .map((friendship) => structuredClone(friendship));
  }

  async createFriendship(friendship: FriendshipDocument) {
    this.friendships.set(friendship.id, structuredClone(friendship));
  }

  async deleteFriendship(friendshipId: string) {
    this.friendships.delete(friendshipId);
  }

  async isBlockedEither(userA: string, userB: string) {
    return [...this.blocks.values()].some(
      (block) =>
        (block.blockerUserId === userA && block.blockedUserId === userB) ||
        (block.blockerUserId === userB && block.blockedUserId === userA),
    );
  }

  async createBlock(block: BlockDocument) {
    this.blocks.set(block.id, structuredClone(block));
  }

  async createNotification(notification: NotificationDocument) {
    this.notifications.set(notification.id, structuredClone(notification));
  }

  async listNotifications(userId: string) {
    return [...this.notifications.values()]
      .filter((notification) => notification.userId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((notification) => structuredClone(notification));
  }

  async markNotificationRead(notificationId: string, userId: string, readAt: string) {
    const notification = this.notifications.get(notificationId);
    if (notification === undefined || notification.userId !== userId) return false;
    this.notifications.set(notificationId, { ...notification, readAt });
    return true;
  }

  async getInvitation(invitationId: string) {
    return cloneOrNull(this.invitations.get(invitationId));
  }

  async findPendingInvitation(tripId: string, inviteeUserId: string) {
    const item = [...this.invitations.values()].find(
      (invitation) =>
        invitation.tripId === tripId &&
        invitation.inviteeUserId === inviteeUserId &&
        invitation.status === 'pending',
    );
    return cloneOrNull(item);
  }

  async createInvitation(invitation: TripInvitationDocument) {
    this.invitations.set(invitation.id, structuredClone(invitation));
  }

  async updateInvitation(invitation: TripInvitationDocument) {
    this.invitations.set(invitation.id, structuredClone(invitation));
  }
}

function cloneOrNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : structuredClone(value);
}
