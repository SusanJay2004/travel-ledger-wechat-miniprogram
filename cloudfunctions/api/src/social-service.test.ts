import { beforeEach, describe, expect, it } from 'vitest';

import type { Clock, IdGenerator, UserDocument } from './models';
import { MemoryRepository } from './repository';
import { LedgerService } from './service';
import { MemorySocialRepository } from './social-repository';
import { SocialService } from './social-service';

class TestClock implements Clock {
  now() {
    return new Date('2026-07-10T08:00:00.000Z');
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
}

describe('SocialService collaboration gates', () => {
  let repository: MemoryRepository;
  let socialRepository: MemorySocialRepository;
  let ledger: LedgerService;
  let social: SocialService;
  let ids: TestIds;
  let alice: UserDocument;
  let bob: UserDocument;
  let carol: UserDocument;

  beforeEach(async () => {
    repository = new MemoryRepository();
    socialRepository = new MemorySocialRepository();
    ids = new TestIds();
    const clock = new TestClock();
    ledger = new LedgerService(repository, clock, ids);
    social = new SocialService(repository, socialRepository, clock, ids, 'collaboration');
    alice = await ledger.bootstrapSession('openid-alice');
    bob = await ledger.bootstrapSession('openid-bob');
    carol = await ledger.bootstrapSession('openid-carol');
  });

  it('rejects every social operation from the solo server mode', async () => {
    const solo = new SocialService(repository, socialRepository, new TestClock(), ids, 'solo');
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

  it('allows an unreferenced member to leave but protects referenced debt history', async () => {
    const request = await social.sendFriendRequest(alice, bob.publicId);
    await social.respondFriendRequest(bob, request.id, true);
    const trip = await ledger.createTrip(alice, { name: '退出规则' });
    const invitation = await social.inviteToTrip(alice, trip.id, bob.id);
    await social.respondTripInvitation(bob, invitation.id, true);
    const left = await social.leaveTrip(bob, trip.id);
    expect(left.memberIds).toEqual([alice.id]);

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
});
