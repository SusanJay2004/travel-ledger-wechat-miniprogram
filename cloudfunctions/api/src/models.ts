import type { BillInput, BillValidationCode, Cents } from '@travel-ledger/domain';

export type TripStatus = 'active' | 'completed';
export type UserTripViewState = 'home' | 'archived' | 'detached';

export interface UserDocument {
  id: string;
  openId: string;
  publicId: string;
  displayName: string;
  signature: string;
  avatarUrl: string | null;
  status: 'active' | 'deleted';
  createdAt: string;
  updatedAt: string;
}

export type FriendRequestStatus = 'pending' | 'accepted' | 'rejected' | 'expired';

export interface FriendRequestDocument {
  id: string;
  fromUserId: string;
  toUserId: string;
  status: FriendRequestStatus;
  createdAt: string;
  expiresAt: string;
  respondedAt: string | null;
}

export interface FriendshipDocument {
  id: string;
  userIds: readonly [string, string];
  createdAt: string;
}

export interface BlockDocument {
  id: string;
  blockerUserId: string;
  blockedUserId: string;
  createdAt: string;
}

export type NotificationType =
  | 'friend_request'
  | 'friend_accepted'
  | 'trip_invitation'
  | 'member_joined'
  | 'member_left'
  | 'trip_completed'
  | 'trip_reopened';

export interface NotificationDocument {
  id: string;
  userId: string;
  type: NotificationType;
  actorUserId: string | null;
  tripId: string | null;
  requestId: string | null;
  invitationId: string | null;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

export type InvitationStatus = 'pending' | 'accepted' | 'rejected' | 'expired';

export interface TripInvitationDocument {
  id: string;
  tripId: string;
  inviterUserId: string;
  inviteeUserId: string;
  status: InvitationStatus;
  createdAt: string;
  expiresAt: string;
  respondedAt: string | null;
}

export interface TripMemberDocument {
  userId: string;
  displayNameSnapshot: string;
  joinedAt: string;
  viewState: UserTripViewState;
  archivedAt: string | null;
  purgeAfter: string | null;
}

export interface BillDocument extends BillInput {
  id: string;
  date: string;
  validationCodes: readonly BillValidationCode[];
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  deletedAt: string | null;
  deletedBy: string | null;
}

export interface TripDocument {
  id: string;
  name: string;
  status: TripStatus;
  memberIds: readonly string[];
  members: readonly TripMemberDocument[];
  dates: readonly string[];
  bills: readonly BillDocument[];
  totalCents: Cents;
  invalidBillCount: number;
  version: number;
  ledgerRevision: number;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  completedAt: string | null;
  completedBy: string | null;
}

export interface TripSummaryDocument {
  id: string;
  name: string;
  status: TripStatus;
  startDate: string | null;
  endDate: string | null;
  totalCents: Cents;
  invalidBillCount: number;
  ledgerRevision: number;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  entityId(prefix: string): string;
  publicId(): string;
}
