import { LIMITS, type ProductMode } from '@travel-ledger/domain';

import { assertBusiness, BusinessError } from './errors';
import type {
  Clock,
  FriendRequestDocument,
  IdGenerator,
  NotificationDocument,
  TripDocument,
  TripInvitationDocument,
  UserDocument,
} from './models';
import type { Repository } from './repository';
import type { SocialRepository } from './social-repository';
import type { TripChangePublisher } from './service';

const noopPublisher: TripChangePublisher = {
  publishTripCreated: async () => undefined,
  publishTripChange: async () => undefined,
};

export interface PublicUserProfile {
  userId: string;
  publicId: string;
  displayName: string;
  signature: string;
  avatarUrl: string | null;
}

export interface FriendView extends PublicUserProfile {
  friendshipId: string;
}

export interface BlockedUserView extends PublicUserProfile {
  blockId: string;
  blockedAt: string;
}

export class SocialService {
  constructor(
    private readonly repository: Repository,
    private readonly social: SocialRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly mode: ProductMode,
    private readonly publisher: TripChangePublisher = noopPublisher,
  ) {}

  async searchByPublicId(
    currentUserId: string,
    publicId: string,
  ): Promise<PublicUserProfile | null> {
    this.assertCollaboration();
    const normalized = publicId.trim().toUpperCase();
    assertBusiness(
      /^[A-Z2-9]{10}$/.test(normalized),
      'PUBLIC_ID_INVALID',
      '请输入完整的 10 位账号 ID。',
    );
    const user = await this.repository.findUserByPublicId(normalized);
    if (user === null || user.status !== 'active' || user.id === currentUserId) return null;
    if (await this.social.isBlockedEither(currentUserId, user.id)) return null;
    return publicProfile(user);
  }

  async sendFriendRequest(
    from: UserDocument,
    targetPublicId: string,
  ): Promise<FriendRequestDocument> {
    this.assertCollaboration();
    const target = await this.repository.findUserByPublicId(targetPublicId.trim().toUpperCase());
    assertBusiness(
      target !== null && target.status === 'active',
      'USER_NOT_FOUND',
      '找不到该用户。',
    );
    assertBusiness(target.id !== from.id, 'CANNOT_FRIEND_SELF', '不能添加自己为好友。');
    assertBusiness(
      !(await this.social.isBlockedEither(from.id, target.id)),
      'FRIEND_REQUEST_UNAVAILABLE',
      '暂时无法向该用户发送申请。',
    );
    assertBusiness(
      (await this.social.getFriendship(from.id, target.id)) === null,
      'ALREADY_FRIENDS',
      '你们已经是好友。',
    );
    const existing = await this.social.findPendingFriendRequest(from.id, target.id);
    if (existing !== null && !isExpired(existing.expiresAt, this.clock.now())) return existing;

    const now = this.clock.now();
    const request: FriendRequestDocument = {
      id: this.ids.entityId('frq'),
      fromUserId: from.id,
      toUserId: target.id,
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: addDays(now, 30).toISOString(),
      respondedAt: null,
    };
    await this.social.createFriendRequest(request);
    await this.bestEffortNotification(
      notification(this.ids, now, {
        userId: target.id,
        type: 'friend_request',
        actorUserId: from.id,
        requestId: request.id,
        title: '新的好友申请',
        body: `${from.displayName} 想添加你为好友`,
      }),
    );
    return request;
  }

  async respondFriendRequest(
    currentUser: UserDocument,
    requestId: string,
    accept: boolean,
  ): Promise<FriendRequestDocument> {
    this.assertCollaboration();
    const request = await this.social.getFriendRequest(requestId);
    assertBusiness(request !== null, 'FRIEND_REQUEST_NOT_FOUND', '找不到该好友申请。');
    assertBusiness(
      request.toUserId === currentUser.id,
      'FORBIDDEN',
      '只有接收方可以处理好友申请。',
    );
    assertBusiness(
      request.status === 'pending',
      'FRIEND_REQUEST_PROCESSED',
      '该好友申请已经处理。',
    );
    assertBusiness(
      !isExpired(request.expiresAt, this.clock.now()),
      'FRIEND_REQUEST_EXPIRED',
      '该好友申请已过期。',
    );
    assertBusiness(
      !(await this.social.isBlockedEither(request.fromUserId, request.toUserId)),
      'FRIEND_REQUEST_UNAVAILABLE',
      '暂时无法处理该申请。',
    );
    const now = this.clock.now();
    const updated: FriendRequestDocument = {
      ...request,
      status: accept ? 'accepted' : 'rejected',
      respondedAt: now.toISOString(),
    };
    if (
      accept &&
      (await this.social.getFriendship(request.fromUserId, request.toUserId)) === null
    ) {
      const userIds = [request.fromUserId, request.toUserId].sort() as [string, string];
      await this.social.createFriendship({
        id: this.ids.entityId('fri'),
        userIds,
        createdAt: now.toISOString(),
      });
      await this.bestEffortNotification(
        notification(this.ids, now, {
          userId: request.fromUserId,
          type: 'friend_accepted',
          actorUserId: currentUser.id,
          requestId: request.id,
          title: '好友申请已通过',
          body: `${currentUser.displayName} 已成为你的好友`,
        }),
      );
    }
    await this.social.updateFriendRequest(updated);
    return updated;
  }

  async listFriends(userId: string): Promise<readonly FriendView[]> {
    this.assertCollaboration();
    const friendships = await this.social.listFriendships(userId);
    const friends = await Promise.all(
      friendships.map(async (friendship) => {
        const friendId = friendship.userIds.find((id) => id !== userId);
        if (friendId === undefined) return null;
        const user = await this.repository.getUser(friendId);
        if (user === null || user.status !== 'active') return null;
        return { ...publicProfile(user), friendshipId: friendship.id };
      }),
    );
    return friends
      .filter((friend): friend is FriendView => friend !== null)
      .sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN'));
  }

  async deleteFriend(userId: string, friendUserId: string): Promise<void> {
    this.assertCollaboration();
    const friendship = await this.social.getFriendship(userId, friendUserId);
    assertBusiness(friendship !== null, 'FRIENDSHIP_NOT_FOUND', '你们当前不是好友。');
    await this.social.deleteFriendship(friendship.id);
  }

  async blockUser(userId: string, blockedUserId: string): Promise<void> {
    this.assertCollaboration();
    assertBusiness(userId !== blockedUserId, 'CANNOT_BLOCK_SELF', '不能拉黑自己。');
    const target = await this.repository.getUser(blockedUserId);
    assertBusiness(
      target !== null && target.status === 'active',
      'USER_NOT_FOUND',
      '找不到该用户。',
    );
    const now = this.clock.now();
    const friendship = await this.social.getFriendship(userId, blockedUserId);
    if (friendship !== null) await this.social.deleteFriendship(friendship.id);
    if ((await this.social.getBlock(userId, blockedUserId)) !== null) return;
    await this.social.createBlock({
      id: this.ids.entityId('blk'),
      blockerUserId: userId,
      blockedUserId,
      createdAt: now.toISOString(),
    });
  }

  async listBlockedUsers(userId: string): Promise<readonly BlockedUserView[]> {
    this.assertCollaboration();
    const blocks = await this.social.listBlocks(userId);
    const views = await Promise.all(
      blocks.map(async (block) => {
        const user = await this.repository.getUser(block.blockedUserId);
        if (user === null) return null;
        return {
          ...publicProfile(user),
          blockId: block.id,
          blockedAt: block.createdAt,
        };
      }),
    );
    return views.filter((view): view is BlockedUserView => view !== null);
  }

  async unblockUser(userId: string, blockedUserId: string): Promise<void> {
    this.assertCollaboration();
    const block = await this.social.getBlock(userId, blockedUserId);
    assertBusiness(block !== null, 'BLOCK_NOT_FOUND', '该用户不在黑名单中。');
    await this.social.deleteBlock(block.id);
  }

  async listNotifications(userId: string): Promise<readonly NotificationDocument[]> {
    this.assertCollaboration();
    return this.social.listNotifications(userId);
  }

  async markNotificationRead(userId: string, notificationId: string): Promise<void> {
    this.assertCollaboration();
    const updated = await this.social.markNotificationRead(
      notificationId,
      userId,
      this.clock.now().toISOString(),
    );
    assertBusiness(updated, 'NOTIFICATION_NOT_FOUND', '找不到该通知。');
  }

  async inviteToTrip(
    inviter: UserDocument,
    tripId: string,
    inviteeUserId: string,
  ): Promise<TripInvitationDocument> {
    this.assertCollaboration();
    const trip = await this.requiredTripForMember(inviter.id, tripId);
    assertBusiness(trip.status === 'active', 'TRIP_COMPLETED', '已完结行程不能邀请成员。');
    assertBusiness(
      !trip.memberIds.includes(inviteeUserId),
      'ALREADY_TRIP_MEMBER',
      '该好友已经在行程中。',
    );
    assertBusiness(
      trip.memberIds.length < LIMITS.membersPerTrip,
      'MEMBER_LIMIT_REACHED',
      '行程成员已满。',
    );
    assertBusiness(
      (await this.social.getFriendship(inviter.id, inviteeUserId)) !== null,
      'INVITEE_NOT_FRIEND',
      '只能邀请自己的好友。',
    );
    assertBusiness(
      !(await this.social.isBlockedEither(inviter.id, inviteeUserId)),
      'INVITATION_UNAVAILABLE',
      '暂时无法邀请该用户。',
    );
    const existing = await this.social.findPendingInvitation(tripId, inviteeUserId);
    if (existing !== null && !isExpired(existing.expiresAt, this.clock.now())) return existing;

    const invitee = await this.repository.getUser(inviteeUserId);
    assertBusiness(
      invitee !== null && invitee.status === 'active',
      'USER_NOT_FOUND',
      '找不到被邀请人。',
    );
    const now = this.clock.now();
    const invitation: TripInvitationDocument = {
      id: this.ids.entityId('inv'),
      tripId,
      inviterUserId: inviter.id,
      inviteeUserId,
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: addDays(now, 7).toISOString(),
      respondedAt: null,
    };
    await this.social.createInvitation(invitation);
    await this.bestEffortNotification(
      notification(this.ids, now, {
        userId: inviteeUserId,
        type: 'trip_invitation',
        actorUserId: inviter.id,
        tripId,
        invitationId: invitation.id,
        title: '新的行程邀请',
        body: `${inviter.displayName} 邀请你加入“${trip.name}”`,
      }),
    );
    return invitation;
  }

  async leaveTrip(currentUser: UserDocument, tripId: string): Promise<TripDocument> {
    this.assertCollaboration();
    const trip = await this.requiredTripForMember(currentUser.id, tripId);
    assertBusiness(
      trip.status === 'active',
      'TRIP_COMPLETED',
      '已完结行程无需退出，请直接个人归档。',
    );
    const referenced = trip.bills.some(
      (bill) =>
        bill.deletedAt === null &&
        (bill.participants.some((participant) => participant.memberId === currentUser.id) ||
          bill.payers.some((payer) => payer.memberId === currentUser.id)),
    );
    assertBusiness(
      !referenced,
      'MEMBER_REFERENCED_BY_BILL',
      '你已被账单引用，需等待行程完结后再归档。',
    );
    assertBusiness(trip.memberIds.length > 1, 'LAST_MEMBER_CANNOT_LEAVE', '单人行程无需退出。');
    const now = this.clock.now();
    const next: TripDocument = {
      ...trip,
      memberIds: trip.memberIds.filter((userId) => userId !== currentUser.id),
      members: trip.members.filter((member) => member.userId !== currentUser.id),
      version: trip.version + 1,
      ledgerRevision: trip.ledgerRevision + 1,
      updatedBy: currentUser.id,
      updatedAt: now.toISOString(),
    };
    const saved = await this.repository.replaceTrip(next, trip.version);
    if (!saved) throw new BusinessError('VERSION_CONFLICT', '行程已被修改，请刷新后重试。');
    await this.publisher.publishTripChange(
      trip,
      next,
      'member.left',
      currentUser.id,
      'member',
      currentUser.id,
    );
    for (const memberId of next.memberIds) {
      await this.bestEffortNotification(
        notification(this.ids, now, {
          userId: memberId,
          type: 'member_left',
          actorUserId: currentUser.id,
          tripId: trip.id,
          title: '成员退出行程',
          body: `${currentUser.displayName} 已退出“${trip.name}”`,
        }),
      );
    }
    return next;
  }

  async respondTripInvitation(
    currentUser: UserDocument,
    invitationId: string,
    accept: boolean,
  ): Promise<TripInvitationDocument> {
    this.assertCollaboration();
    const invitation = await this.social.getInvitation(invitationId);
    assertBusiness(invitation !== null, 'INVITATION_NOT_FOUND', '找不到该行程邀请。');
    assertBusiness(
      invitation.inviteeUserId === currentUser.id,
      'FORBIDDEN',
      '只有被邀请人可以处理邀请。',
    );
    assertBusiness(invitation.status === 'pending', 'INVITATION_PROCESSED', '该邀请已经处理。');
    assertBusiness(
      !isExpired(invitation.expiresAt, this.clock.now()),
      'INVITATION_EXPIRED',
      '该邀请已过期。',
    );
    const now = this.clock.now();
    if (accept) {
      const trip = await this.repository.getTrip(invitation.tripId);
      assertBusiness(
        trip !== null && trip.status === 'active',
        'TRIP_UNAVAILABLE',
        '该行程已无法加入。',
      );
      assertBusiness(
        !trip.memberIds.includes(currentUser.id),
        'ALREADY_TRIP_MEMBER',
        '你已经在该行程中。',
      );
      assertBusiness(
        trip.memberIds.length < LIMITS.membersPerTrip,
        'MEMBER_LIMIT_REACHED',
        '行程成员已满。',
      );
      assertBusiness(
        (await this.repository.countHomeTrips(currentUser.id)) < LIMITS.activeTripsPerUser,
        'TRIP_LIMIT_REACHED',
        '你的首页行程已满，暂时无法接受邀请。',
      );
      const next: TripDocument = {
        ...trip,
        memberIds: [...trip.memberIds, currentUser.id],
        members: [
          ...trip.members,
          {
            userId: currentUser.id,
            displayNameSnapshot: currentUser.displayName,
            joinedAt: now.toISOString(),
            viewState: 'home',
            archivedAt: null,
            purgeAfter: null,
          },
        ],
        version: trip.version + 1,
        ledgerRevision: trip.ledgerRevision + 1,
        updatedBy: currentUser.id,
        updatedAt: now.toISOString(),
      };
      const saved = await this.repository.replaceTrip(next, trip.version);
      if (!saved) throw new BusinessError('VERSION_CONFLICT', '行程已被修改，请重新处理邀请。');
      await this.publisher.publishTripChange(
        trip,
        next,
        'member.joined',
        currentUser.id,
        'member',
        currentUser.id,
      );
      for (const memberId of trip.memberIds) {
        await this.bestEffortNotification(
          notification(this.ids, now, {
            userId: memberId,
            type: 'member_joined',
            actorUserId: currentUser.id,
            tripId: trip.id,
            invitationId: invitation.id,
            title: '新成员加入行程',
            body: `${currentUser.displayName} 已加入“${trip.name}”`,
          }),
        );
      }
    }
    const updated: TripInvitationDocument = {
      ...invitation,
      status: accept ? 'accepted' : 'rejected',
      respondedAt: now.toISOString(),
    };
    await this.social.updateInvitation(updated);
    return updated;
  }

  private async bestEffortNotification(item: NotificationDocument): Promise<void> {
    try {
      await this.social.createNotification(item);
    } catch {
      console.error('notification-publish-failed', {
        notificationId: item.id,
        type: item.type,
        userId: item.userId,
        tripId: item.tripId,
      });
    }
  }

  private assertCollaboration(): void {
    if (this.mode !== 'collaboration') {
      throw new BusinessError('FEATURE_DISABLED', '当前发布版本未开放好友与多人协作功能。');
    }
  }

  private async requiredTripForMember(userId: string, tripId: string) {
    const trip = await this.repository.getTrip(tripId);
    assertBusiness(trip !== null, 'TRIP_NOT_FOUND', '找不到该行程。');
    assertBusiness(trip.memberIds.includes(userId), 'FORBIDDEN', '你不是该行程成员。');
    return trip;
  }
}

function publicProfile(user: UserDocument): PublicUserProfile {
  return {
    userId: user.id,
    publicId: user.publicId,
    displayName: user.displayName,
    signature: user.signature,
    avatarUrl: user.avatarUrl,
  };
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function isExpired(expiresAt: string, now: Date): boolean {
  return new Date(expiresAt).getTime() <= now.getTime();
}

function notification(
  ids: IdGenerator,
  now: Date,
  values: Pick<NotificationDocument, 'userId' | 'type' | 'actorUserId' | 'title' | 'body'> &
    Partial<Pick<NotificationDocument, 'tripId' | 'requestId' | 'invitationId'>>,
): NotificationDocument {
  return {
    id: ids.entityId('not'),
    userId: values.userId,
    type: values.type,
    actorUserId: values.actorUserId,
    tripId: values.tripId ?? null,
    requestId: values.requestId ?? null,
    invitationId: values.invitationId ?? null,
    title: values.title,
    body: values.body,
    readAt: null,
    createdAt: now.toISOString(),
  };
}
