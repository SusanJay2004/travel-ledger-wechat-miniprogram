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
