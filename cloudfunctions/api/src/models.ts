import type { BillInput, BillValidationCode, Cents, SettlementResult } from '@travel-ledger/domain';

export type TripStatus = 'active' | 'completed';
export type UserTripViewState = 'home' | 'archived' | 'detached';

export interface UserDocument {
  id: string;
  openId: string;
  publicId: string;
  displayName: string;
  signature: string;
  avatarUrl: string | null;
  qrCodeFileId?: string | null;
  qrSceneToken?: string | null;
  pendingFileDeletionIds?: readonly string[];
  homeTripCount: number;
  status: 'active' | 'deleting' | 'deleted';
  version: number;
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

export interface SyncEventDocument {
  id: string;
  userId: string;
  ownerOpenId: string;
  tripId: string;
  ledgerRevision: number;
  action: string;
  actorUserId: string;
  createdAt: string;
}

export interface AuditLogDocument {
  id: string;
  tripId: string;
  actorUserId: string;
  action: string;
  entityType: 'trip' | 'date' | 'bill' | 'member';
  entityId: string;
  beforeVersion: number;
  afterVersion: number;
  createdAt: string;
}

export interface ProjectionOutboxEntry {
  id: string;
  action: string;
  actorUserId: string;
  entityType: AuditLogDocument['entityType'];
  entityId: string;
  beforeVersion: number;
  afterVersion: number;
  ledgerRevision: number;
  targetUserIds: readonly string[];
  notification?: {
    type: NotificationType;
    title: string;
    body: string;
    targetUserIds: readonly string[];
  };
  createdAt: string;
}

export interface IdempotencyRecordDocument {
  id: string;
  ownerOpenId: string;
  requestId: string;
  action: string;
  status: 'processing' | 'completed' | 'failed';
  response: unknown;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Readonly<Record<string, unknown>>;
  } | null;
  createdAt: string;
  expiresAt: string;
}

export interface RateLimitRecordDocument {
  id: string;
  ownerHash: string;
  requestId: string;
  scope: string;
  bucket: string;
  createdAt: string;
  expiresAt: string;
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
  settlementCache?: {
    result: SettlementResult;
    ignoredBillIds: readonly string[];
    includedCents: number;
    ledgerRevision: number;
    calculatedAt: string;
  } | null;
  projectionOutbox?: readonly ProjectionOutboxEntry[];
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
  sceneToken(): string;
}
