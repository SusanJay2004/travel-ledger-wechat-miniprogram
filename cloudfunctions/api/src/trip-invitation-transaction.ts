import { LIMITS } from '@travel-ledger/domain';

import type { CloudCollection, CloudDatabase } from './cloud-repository';
import type { TripDocument, TripInvitationDocument, UserDocument } from './models';
import type { Repository } from './repository';
import type { SocialRepository } from './social-repository';

export type TripInvitationAcceptanceOutcome =
  | 'saved'
  | 'invitation_conflict'
  | 'invitation_expired'
  | 'version_conflict'
  | 'trip_unavailable'
  | 'inviter_left'
  | 'authorization_changed'
  | 'already_member'
  | 'member_limit_reached'
  | 'capacity_exceeded'
  | 'user_inactive';

export interface TripInvitationAcceptanceInput {
  invitation: TripInvitationDocument;
  nextTrip: TripDocument;
  expectedTripVersion: number;
}

export interface TripInvitationAcceptance {
  commit(input: TripInvitationAcceptanceInput): Promise<TripInvitationAcceptanceOutcome>;
  reject(
    invitation: TripInvitationDocument,
  ): Promise<'saved' | 'invitation_conflict' | 'invitation_expired'>;
}

export class CloudTripInvitationAcceptance implements TripInvitationAcceptance {
  constructor(private readonly db: CloudDatabase) {}

  async commit(input: TripInvitationAcceptanceInput): Promise<TripInvitationAcceptanceOutcome> {
    let outcome: TripInvitationAcceptanceOutcome = 'invitation_conflict';
    await this.db.runTransaction(async (transaction) => {
      const invitationReference = transaction
        .collection<TripInvitationDocument>('trip_invitations')
        .doc(input.invitation.id);
      const currentInvitation = (await invitationReference.get()).data;
      if (
        currentInvitation.status !== 'pending' ||
        currentInvitation.tripId !== input.invitation.tripId ||
        currentInvitation.inviterUserId !== input.invitation.inviterUserId ||
        currentInvitation.inviteeUserId !== input.invitation.inviteeUserId
      ) {
        outcome = 'invitation_conflict';
        return;
      }
      if (
        input.invitation.respondedAt === null ||
        currentInvitation.expiresAt <= input.invitation.respondedAt
      ) {
        outcome = 'invitation_expired';
        return;
      }

      const tripReference = transaction.collection<TripDocument>('trips').doc(input.nextTrip.id);
      const currentTrip = (await tripReference.get()).data;
      if (currentTrip.version !== input.expectedTripVersion) {
        outcome = 'version_conflict';
        return;
      }
      if (currentTrip.status !== 'active') {
        outcome = 'trip_unavailable';
        return;
      }
      if (
        !currentTrip.members.some(
          (member) =>
            member.userId === currentInvitation.inviterUserId && member.viewState === 'home',
        )
      ) {
        outcome = 'inviter_left';
        return;
      }
      if (currentTrip.memberIds.includes(currentInvitation.inviteeUserId)) {
        outcome = 'already_member';
        return;
      }
      if (currentTrip.memberIds.length >= LIMITS.membersPerTrip) {
        outcome = 'member_limit_reached';
        return;
      }

      const friendships = await listAll(
        transaction
          .collection<{ userIds: readonly string[] }>('friendships')
          .where({ userIds: currentInvitation.inviterUserId }),
      );
      const friends = friendships.some((friendship) =>
        friendship.userIds.includes(currentInvitation.inviteeUserId),
      );
      const [forwardBlock, reverseBlock] = await Promise.all([
        transaction
          .collection('blocks')
          .where({
            blockerUserId: currentInvitation.inviterUserId,
            blockedUserId: currentInvitation.inviteeUserId,
          })
          .limit(1)
          .get(),
        transaction
          .collection('blocks')
          .where({
            blockerUserId: currentInvitation.inviteeUserId,
            blockedUserId: currentInvitation.inviterUserId,
          })
          .limit(1)
          .get(),
      ]);
      if (!friends || forwardBlock.data.length > 0 || reverseBlock.data.length > 0) {
        outcome = 'authorization_changed';
        return;
      }

      const userReference = transaction
        .collection<UserDocument>('users')
        .doc(currentInvitation.inviteeUserId);
      const user = (await userReference.get()).data;
      if (user.status !== 'active') {
        outcome = 'user_inactive';
        return;
      }
      if (user.homeTripCount >= LIMITS.activeTripsPerUser) {
        outcome = 'capacity_exceeded';
        return;
      }

      outcome = 'saved';
      await userReference.set({
        data: withoutDocumentId({
          ...user,
          homeTripCount: user.homeTripCount + 1,
          version: user.version + 1,
        }),
      });
      await tripReference.set({ data: withoutDocumentId(input.nextTrip) });
      await invitationReference.set({ data: withoutDocumentId(input.invitation) });
    });
    return outcome;
  }

  async reject(
    invitation: TripInvitationDocument,
  ): Promise<'saved' | 'invitation_conflict' | 'invitation_expired'> {
    let outcome: 'saved' | 'invitation_conflict' | 'invitation_expired' = 'invitation_conflict';
    await this.db.runTransaction(async (transaction) => {
      const reference = transaction
        .collection<TripInvitationDocument>('trip_invitations')
        .doc(invitation.id);
      const current = (await reference.get()).data;
      if (
        current.status !== 'pending' ||
        current.tripId !== invitation.tripId ||
        current.inviterUserId !== invitation.inviterUserId ||
        current.inviteeUserId !== invitation.inviteeUserId
      ) {
        outcome = 'invitation_conflict';
        return;
      }
      if (invitation.respondedAt === null || current.expiresAt <= invitation.respondedAt) {
        outcome = 'invitation_expired';
        return;
      }
      outcome = 'saved';
      await reference.set({ data: withoutDocumentId(invitation) });
    });
    return outcome;
  }
}

export class MemoryTripInvitationAcceptance implements TripInvitationAcceptance {
  constructor(
    private readonly repository: Repository,
    private readonly social: SocialRepository,
  ) {}

  async commit(input: TripInvitationAcceptanceInput): Promise<TripInvitationAcceptanceOutcome> {
    const currentInvitation = await this.social.getInvitation(input.invitation.id);
    if (currentInvitation === null || currentInvitation.status !== 'pending') {
      return 'invitation_conflict';
    }
    const currentTrip = await this.repository.getTrip(input.nextTrip.id);
    if (currentTrip === null || currentTrip.status !== 'active') return 'trip_unavailable';
    if (currentTrip.version !== input.expectedTripVersion) return 'version_conflict';
    if (
      !currentTrip.members.some(
        (member) =>
          member.userId === currentInvitation.inviterUserId && member.viewState === 'home',
      )
    ) {
      return 'inviter_left';
    }
    if (
      (await this.social.getFriendship(
        currentInvitation.inviterUserId,
        currentInvitation.inviteeUserId,
      )) === null ||
      (await this.social.isBlockedEither(
        currentInvitation.inviterUserId,
        currentInvitation.inviteeUserId,
      ))
    ) {
      return 'authorization_changed';
    }
    if (currentTrip.memberIds.includes(currentInvitation.inviteeUserId)) return 'already_member';
    if (currentTrip.memberIds.length >= LIMITS.membersPerTrip) return 'member_limit_reached';
    const saved = await this.repository.replaceTripWithHomeCapacity(
      input.nextTrip,
      input.expectedTripVersion,
      { [currentInvitation.inviteeUserId]: 1 },
      LIMITS.activeTripsPerUser,
    );
    if (saved !== 'saved') return saved;
    await this.social.updateInvitation(input.invitation);
    return 'saved';
  }

  async reject(
    invitation: TripInvitationDocument,
  ): Promise<'saved' | 'invitation_conflict' | 'invitation_expired'> {
    const current = await this.social.getInvitation(invitation.id);
    if (current === null || current.status !== 'pending') return 'invitation_conflict';
    if (invitation.respondedAt === null || current.expiresAt <= invitation.respondedAt) {
      return 'invitation_expired';
    }
    await this.social.updateInvitation(invitation);
    return 'saved';
  }
}

async function listAll<T>(collection: CloudCollection<T>): Promise<T[]> {
  const result: T[] = [];
  let offset = 0;
  while (true) {
    const response = await collection.skip(offset).limit(100).get();
    result.push(...response.data);
    if (response.data.length < 100) return result;
    offset += response.data.length;
  }
}

function withoutDocumentId<T extends { id: string }>(value: T): T {
  const copy = { ...value } as T & { _id?: string };
  delete copy._id;
  return copy;
}
