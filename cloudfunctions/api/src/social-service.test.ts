import { beforeEach, describe, expect, it } from 'vitest';

import type { Clock, IdGenerator, UserDocument } from './models';
import { MemoryRepository } from './repository';
import { LedgerService } from './service';
import { MemorySocialRepository } from './social-repository';
import { SocialService } from './social-service';
import { MemoryTripInvitationAcceptance } from './trip-invitation-transaction';
import { MemoryFriendRequestTransition } from './friend-request-transaction';
import { MemorySocialRelationshipTransition } from './social-relationship-transaction';

class TestClock implements Clock {
  private current = new Date('2026-07-10T08:00:00.000Z');

  now() {
    return new Date(this.current);
  }

  advanceDays(days: number) {
    this.current = new Date(this.current.getTime() + days * 24 * 60 * 60 * 1000);
  }
}

class TestIds implements IdGenerator {
  private sequence = 0;

  entityId(prefix: string) {
    this.sequence += 1;
    return `${prefix}_${this.sequence}`;
  }

  publicId() {
    this.sequence += 1;
    return `ABCDEFGH${String(this.sequence + 22).padStart(2, '2')}`;
  }

  sceneToken() {
    this.sequence += 1;
    return `scenetoken${String(this.sequence).padStart(10, '0')}`;
  }
}

describe('SocialService collaboration gates', () => {
  let repository: MemoryRepository;
  let socialRepository: MemorySocialRepository;
  let ledger: LedgerService;
  let social: SocialService;
  let ids: TestIds;
  let clock: TestClock;
  let alice: UserDocument;
  let bob: UserDocument;
  let carol: UserDocument;

  beforeEach(async () => {
    repository = new MemoryRepository();
    socialRepository = new MemorySocialRepository();
    ids = new TestIds();
    clock = new TestClock();
    ledger = new LedgerService(repository, clock, ids);
    social = new SocialService(
      repository,
      socialRepository,
      clock,
      ids,
      'collaboration',
      undefined,
      new MemoryTripInvitationAcceptance(repository, socialRepository),
      new MemoryFriendRequestTransition(repository, socialRepository),
      new MemorySocialRelationshipTransition(repository, socialRepository),
    );
    alice = await ledger.bootstrapSession('openid-alice');
    bob = await ledger.bootstrapSession('openid-bob');
    carol = await ledger.bootstrapSession('openid-carol');
  });

  it('rejects every social operation from the solo server mode', async () => {
    const solo = new SocialService(
      repository,
      socialRepository,
      new TestClock(),
      ids,
      'solo',
      undefined,
      new MemoryTripInvitationAcceptance(repository, socialRepository),
      new MemoryFriendRequestTransition(repository, socialRepository),
      new MemorySocialRelationshipTransition(repository, socialRepository),
    );
    await expect(solo.listFriends(alice.id)).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
    await expect(solo.sendFriendRequest(alice, bob.publicId)).rejects.toMatchObject({
      code: 'FEATURE_DISABLED',
    });
  });

  it('only lets the recipient accept a friend request', async () => {
    const request = await social.sendFriendRequest(alice, bob.publicId);
    await expect(social.respondFriendRequest(carol, request.id, true)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await social.respondFriendRequest(bob, request.id, true);
    expect((await social.listFriends(alice.id)).map((friend) => friend.userId)).toEqual([bob.id]);
    expect(await social.listNotifications(alice.id)).toHaveLength(1);
  });

  it('recovers missing actionable notifications from pending social records', async () => {
    class FailingNotificationRepository extends MemorySocialRepository {
      override async createNotification() {
        throw new Error('notification unavailable');
      }
    }
    const failingRepository = new FailingNotificationRepository();
    const failingSocial = new SocialService(
      repository,
      failingRepository,
      clock,
      ids,
      'collaboration',
      undefined,
      new MemoryTripInvitationAcceptance(repository, failingRepository),
      new MemoryFriendRequestTransition(repository, failingRepository),
      new MemorySocialRelationshipTransition(repository, failingRepository),
    );
    const friendRequest = await failingSocial.sendFriendRequest(alice, bob.publicId);
    await failingSocial.respondFriendRequest(bob, friendRequest.id, true);
    const trip = await ledger.createTrip(alice, { name: '通知恢复' });
    const invitation = await failingSocial.inviteToTrip(alice, trip.id, bob.id);

    const recovered = await failingSocial.listNotifications(bob.id);

    expect(recovered).toEqual([
      expect.objectContaining({
        type: 'trip_invitation',
        invitationId: invitation.id,
        userId: bob.id,
      }),
    ]);
    await expect(
      failingSocial.markNotificationRead(bob.id, recovered[0]!.id),
    ).resolves.toBeUndefined();
    await failingSocial.respondTripInvitation(bob, invitation.id, false);
    expect(await failingSocial.listNotifications(bob.id)).toEqual([]);
  });

  it('does not synthesize duplicates when persisted notifications already exist', async () => {
    const request = await social.sendFriendRequest(alice, bob.publicId);
    const stored = await socialRepository.listNotifications(bob.id);
    await socialRepository.markNotificationRead(stored[0]!.id, bob.id, clock.now().toISOString());
    const notifications = await social.listNotifications(bob.id);

    expect(notifications.filter((item) => item.requestId === request.id)).toHaveLength(1);
    expect(notifications[0]?.readAt).toBeNull();
  });

  it('only exposes action identifiers while the matching request is pending', async () => {
    const request = await social.sendFriendRequest(alice, bob.publicId);
    await social.respondFriendRequest(bob, request.id, true);

    const bobNotifications = await social.listNotifications(bob.id);
    const aliceNotifications = await social.listNotifications(alice.id);

    expect(bobNotifications.find((item) => item.type === 'friend_request')).toMatchObject({
      requestId: null,
    });
    expect(aliceNotifications.find((item) => item.type === 'friend_accepted')).toMatchObject({
      requestId: null,
    });
  });

  it('persists a deterministic recovered notification exactly once', async () => {
    await socialRepository.createFriendRequest({
      id: 'frq_recovery',
      fromUserId: alice.id,
      toUserId: bob.id,
      status: 'pending',
      createdAt: clock.now().toISOString(),
      expiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
      respondedAt: null,
    });

    const first = await social.listNotifications(bob.id);
    const second = await social.listNotifications(bob.id);

    expect(first).toEqual([
      expect.objectContaining({ id: 'not_recovered_frq_recovery', requestId: 'frq_recovery' }),
    ]);
    expect(second).toEqual(first);
    expect(await socialRepository.listNotifications(bob.id)).toHaveLength(1);
  });

  it('requires friendship before a trip invitation', async () => {
    const trip = await ledger.createTrip(alice, { name: '好友旅行' });
    await expect(social.inviteToTrip(alice, trip.id, bob.id)).rejects.toMatchObject({
      code: 'INVITEE_NOT_FRIEND',
    });
  });

  it('only lets the invitee accept and then grants trip membership', async () => {
    const request = await social.sendFriendRequest(alice, bob.publicId);
    await social.respondFriendRequest(bob, request.id, true);
    const trip = await ledger.createTrip(alice, { name: '协作旅行' });
    const invitation = await social.inviteToTrip(alice, trip.id, bob.id);

    await expect(social.respondTripInvitation(carol, invitation.id, true)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await social.respondTripInvitation(bob, invitation.id, true);
    const joined = await ledger.getTrip(bob.id, trip.id);
    expect(joined.memberIds).toEqual([alice.id, bob.id]);
    expect(joined.members[1]?.displayNameSnapshot).toBe(bob.displayName);
    expect((await repository.getUser(bob.id))?.homeTripCount).toBe(1);
  });

  it('makes blocking remove friendship and hide exact ID search', async () => {
    const request = await social.sendFriendRequest(alice, bob.publicId);
    await social.respondFriendRequest(bob, request.id, true);
    await social.blockUser(alice.id, bob.id);
    expect(await social.listFriends(alice.id)).toEqual([]);
    expect(await social.searchByPublicId(bob.id, alice.publicId)).toBeNull();
    expect((await social.listBlockedUsers(alice.id)).map((item) => item.userId)).toEqual([bob.id]);
    await social.unblockUser(alice.id, bob.id);
    expect(await social.listBlockedUsers(alice.id)).toEqual([]);
    expect(await social.searchByPublicId(bob.id, alice.publicId)).not.toBeNull();
  });

  it('resolves an opaque QR token without exposing identity in the scene', async () => {
    await repository.updateUser(
      { ...alice, qrSceneToken: 'AbCdEfGhIjKlMnOpQr_2', version: alice.version + 1 },
      alice.version,
    );
    expect(await social.resolveQrScene(bob.id, 'AbCdEfGhIjKlMnOpQr_2')).toMatchObject({
      publicId: alice.publicId,
    });
    expect(await social.resolveQrScene(alice.id, 'AbCdEfGhIjKlMnOpQr_2')).toBeNull();
    await expect(social.resolveQrScene(bob.id, alice.publicId)).rejects.toMatchObject({
      code: 'QR_SCENE_INVALID',
    });
  });

  it('allows an unreferenced member to leave but protects referenced debt history', async () => {
    const request = await social.sendFriendRequest(alice, bob.publicId);
    await social.respondFriendRequest(bob, request.id, true);
    const trip = await ledger.createTrip(alice, { name: '退出规则' });
    const invitation = await social.inviteToTrip(alice, trip.id, bob.id);
    await social.respondTripInvitation(bob, invitation.id, true);
    const left = await social.leaveTrip(bob, trip.id);
    expect(left.memberIds).toEqual([alice.id]);
    expect((await repository.getUser(bob.id))?.homeTripCount).toBe(0);

    const secondTrip = await ledger.createTrip(alice, { name: '账单保护' });
    const secondInvitation = await social.inviteToTrip(alice, secondTrip.id, bob.id);
    await social.respondTripInvitation(bob, secondInvitation.id, true);
    const joined = await ledger.getTrip(alice.id, secondTrip.id);
    const dated = await ledger.addDate(alice.id, {
      tripId: secondTrip.id,
      date: '2026-07-10',
      expectedVersion: joined.version,
    });
    await ledger.addBill(alice.id, {
      tripId: secondTrip.id,
      date: '2026-07-10',
      expectedVersion: dated.version,
      bill: {
        title: '车票',
        amountCents: 200,
        participants: [
          { memberId: alice.id, displayName: alice.displayName, shares: 1 },
          { memberId: bob.id, displayName: bob.displayName, shares: 1 },
        ],
        payers: [{ memberId: alice.id, displayName: alice.displayName, paidCents: 200 }],
      },
    });
    await expect(social.leaveTrip(bob, secondTrip.id)).rejects.toMatchObject({
      code: 'MEMBER_REFERENCED_BY_BILL',
    });
  });

  it('rejects expired friend requests and trip invitations', async () => {
    const request = await social.sendFriendRequest(alice, bob.publicId);
    clock.advanceDays(30);
    await expect(social.respondFriendRequest(bob, request.id, true)).rejects.toMatchObject({
      code: 'FRIEND_REQUEST_EXPIRED',
    });

    const currentRequest = await social.sendFriendRequest(alice, carol.publicId);
    await social.respondFriendRequest(carol, currentRequest.id, true);
    const trip = await ledger.createTrip(alice, { name: '过期邀请' });
    const invitation = await social.inviteToTrip(alice, trip.id, carol.id);
    clock.advanceDays(7);
    await expect(social.respondTripInvitation(carol, invitation.id, true)).rejects.toMatchObject({
      code: 'INVITATION_EXPIRED',
    });
  });

  it('rechecks member and home-trip limits when an invitation is accepted', async () => {
    const request = await social.sendFriendRequest(alice, bob.publicId);
    await social.respondFriendRequest(bob, request.id, true);
    const trip = await ledger.createTrip(alice, { name: '容量检查' });
    const invitation = await social.inviteToTrip(alice, trip.id, bob.id);

    const storedBob = (await repository.getUser(bob.id))!;
    await repository.updateUser(
      { ...storedBob, homeTripCount: 100, version: storedBob.version + 1 },
      storedBob.version,
    );
    await expect(social.respondTripInvitation(bob, invitation.id, true)).rejects.toMatchObject({
      code: 'TRIP_LIMIT_REACHED',
    });

    const current = await repository.getTrip(trip.id);
    expect(current).not.toBeNull();
    const fillerIds = Array.from({ length: 19 }, (_, index) => `filler_${index}`);
    await repository.replaceTrip(
      {
        ...current!,
        memberIds: [alice.id, ...fillerIds],
        members: [
          ...current!.members,
          ...fillerIds.map((userId) => ({
            userId,
            displayNameSnapshot: userId,
            joinedAt: clock.now().toISOString(),
            viewState: 'home' as const,
            archivedAt: null,
            purgeAfter: null,
          })),
        ],
      },
      current!.version,
    );
    await expect(social.respondTripInvitation(bob, invitation.id, true)).rejects.toMatchObject({
      code: 'MEMBER_LIMIT_REACHED',
    });
  });

  it('rechecks current authorization before accepting an invitation', async () => {
    const request = await social.sendFriendRequest(alice, bob.publicId);
    await social.respondFriendRequest(bob, request.id, true);

    const friendshipTrip = await ledger.createTrip(alice, { name: '好友失效' });
    const friendshipInvitation = await social.inviteToTrip(alice, friendshipTrip.id, bob.id);
    await social.deleteFriend(alice.id, bob.id);
    await expect(
      social.respondTripInvitation(bob, friendshipInvitation.id, true),
    ).rejects.toMatchObject({ code: 'INVITATION_FRIENDSHIP_ENDED' });

    const newRequest = await social.sendFriendRequest(alice, bob.publicId);
    await social.respondFriendRequest(bob, newRequest.id, true);
    const blockedTrip = await ledger.createTrip(alice, { name: '拉黑失效' });
    const blockedInvitation = await social.inviteToTrip(alice, blockedTrip.id, bob.id);
    await social.blockUser(alice.id, bob.id);
    await expect(
      social.respondTripInvitation(bob, blockedInvitation.id, true),
    ).rejects.toMatchObject({ code: 'INVITATION_FRIENDSHIP_ENDED' });

    await social.unblockUser(alice.id, bob.id);
    const finalRequest = await social.sendFriendRequest(alice, bob.publicId);
    await social.respondFriendRequest(bob, finalRequest.id, true);
    const inviterTrip = await ledger.createTrip(alice, { name: '邀请人退出' });
    const inviterInvitation = await social.inviteToTrip(alice, inviterTrip.id, bob.id);
    const carolRequest = await social.sendFriendRequest(alice, carol.publicId);
    await social.respondFriendRequest(carol, carolRequest.id, true);
    const carolInvitation = await social.inviteToTrip(alice, inviterTrip.id, carol.id);
    await social.respondTripInvitation(carol, carolInvitation.id, true);
    await social.leaveTrip(alice, inviterTrip.id);
    await expect(
      social.respondTripInvitation(bob, inviterInvitation.id, true),
    ).rejects.toMatchObject({ code: 'INVITER_LEFT_TRIP' });
  });

  it('does not authorize a permanently detached historical member', async () => {
    for (const target of [bob, carol]) {
      const request = await social.sendFriendRequest(alice, target.publicId);
      await social.respondFriendRequest(target, request.id, true);
    }
    const trip = await ledger.createTrip(alice, { name: '历史成员隔离' });
    const bobInvitation = await social.inviteToTrip(alice, trip.id, bob.id);
    await social.respondTripInvitation(bob, bobInvitation.id, true);
    const staleInvitation = await social.inviteToTrip(alice, trip.id, carol.id);

    const joined = await ledger.getTrip(alice.id, trip.id);
    const completed = await ledger.completeTrip(alice.id, {
      tripId: trip.id,
      expectedVersion: joined.version,
      ignoreInvalidBills: false,
    });
    const archived = await ledger.archiveTrip(alice.id, {
      tripId: trip.id,
      expectedVersion: completed.version,
    });
    const detached = await ledger.removeArchivedTrip(alice.id, {
      tripId: trip.id,
      expectedVersion: archived.version,
    });
    await ledger.reopenTrip(bob.id, {
      tripId: trip.id,
      expectedVersion: detached.version,
    });

    await expect(social.inviteToTrip(alice, trip.id, carol.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      social.respondTripInvitation(carol, staleInvitation.id, true),
    ).rejects.toMatchObject({ code: 'INVITER_LEFT_TRIP' });
  });

  it('rejects invitation acceptance after the invitee account starts deleting', async () => {
    const request = await social.sendFriendRequest(alice, bob.publicId);
    await social.respondFriendRequest(bob, request.id, true);
    const trip = await ledger.createTrip(alice, { name: '注销邀请竞态' });
    const invitation = await social.inviteToTrip(alice, trip.id, bob.id);
    const storedBob = (await repository.getUser(bob.id))!;
    await repository.updateUser(
      { ...storedBob, status: 'deleting', version: storedBob.version + 1 },
      storedBob.version,
    );

    await expect(social.respondTripInvitation(bob, invitation.id, true)).rejects.toMatchObject({
      code: 'ACCOUNT_DELETION_PENDING',
    });
    expect((await repository.getTrip(trip.id))?.memberIds).toEqual([alice.id]);
    expect((await repository.getUser(bob.id))?.homeTripCount).toBe(0);
  });
});
