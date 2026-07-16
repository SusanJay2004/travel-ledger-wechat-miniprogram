import type { ProductMode } from './constants.js';

export type Cents = number;
export type CalendarDate = `${number}-${number}-${number}`;

export interface MemberSnapshot {
  memberId: string;
  displayName: string;
}

export interface ParticipantShare extends MemberSnapshot {
  shares: number;
}

export interface PayerAmount extends MemberSnapshot {
  paidCents: Cents;
}

export interface BillInput {
  title: string;
  amountCents: Cents;
  participants: readonly ParticipantShare[];
  payers: readonly PayerAmount[];
}

export type BillValidationCode =
  | 'TITLE_REQUIRED'
  | 'TITLE_TOO_LONG'
  | 'TITLE_HAS_CONTROL_CHARACTER'
  | 'AMOUNT_INVALID'
  | 'PARTICIPANTS_REQUIRED'
  | 'PARTICIPANT_DUPLICATE'
  | 'PARTICIPANT_SHARE_INVALID'
  | 'PARTICIPANT_SHARE_SUM_INVALID'
  | 'PAYERS_REQUIRED'
  | 'PAYER_DUPLICATE'
  | 'PAYER_AMOUNT_INVALID'
  | 'PAYER_AMOUNT_SUM_INVALID';

export interface ValidationIssue {
  code: BillValidationCode;
  path: string;
}

export interface Allocation {
  memberId: string;
  amountCents: Cents;
}

export interface MemberBalance extends MemberSnapshot {
  paidCents: Cents;
  owedCents: Cents;
  netCents: Cents;
}

export interface Transfer {
  fromMemberId: string;
  toMemberId: string;
  amountCents: Cents;
}

export interface SettlementResult {
  balances: readonly MemberBalance[];
  transfers: readonly Transfer[];
  minimumTransferCount: number;
}

export interface RuntimeConfig {
  mode: ProductMode;
  collaborationEnabled: boolean;
}
