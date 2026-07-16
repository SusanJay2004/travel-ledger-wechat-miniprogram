import { LIMITS } from './constants.js';
import type { BillInput, ValidationIssue } from './types.js';

const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;
const USERNAME = /^[\p{Script=Han}A-Za-z0-9]+$/u;
const TRIP_NAME = /^[\p{Script=Han}A-Za-z0-9]+(?: [\p{Script=Han}A-Za-z0-9]+)*$/u;

export function codePointLength(value: string): number {
  return [...value].length;
}

export function isValidUsername(value: string): boolean {
  const length = codePointLength(value);
  return length >= 2 && length <= LIMITS.usernameCodePoints && USERNAME.test(value);
}

export function isValidTripName(value: string): boolean {
  const length = codePointLength(value);
  return length >= 1 && length <= LIMITS.tripNameCodePoints && TRIP_NAME.test(value);
}

export function isValidSignature(value: string): boolean {
  return codePointLength(value) <= LIMITS.signatureCodePoints && !CONTROL_CHARACTERS.test(value);
}

export function validateBill(input: BillInput): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const title = input.title.trim();

  if (title.length === 0) issues.push({ code: 'TITLE_REQUIRED', path: 'title' });
  if (codePointLength(title) > LIMITS.billTitleCodePoints) {
    issues.push({ code: 'TITLE_TOO_LONG', path: 'title' });
  }
  if (CONTROL_CHARACTERS.test(input.title)) {
    issues.push({ code: 'TITLE_HAS_CONTROL_CHARACTER', path: 'title' });
  }
  if (
    !Number.isSafeInteger(input.amountCents) ||
    input.amountCents < 1 ||
    input.amountCents > LIMITS.maxBillAmountCents
  ) {
    issues.push({ code: 'AMOUNT_INVALID', path: 'amountCents' });
  }

  if (input.participants.length === 0) {
    issues.push({ code: 'PARTICIPANTS_REQUIRED', path: 'participants' });
  }
  const participantIds = new Set<string>();
  let shareSum = 0;
  input.participants.forEach((participant, index) => {
    if (participantIds.has(participant.memberId)) {
      issues.push({ code: 'PARTICIPANT_DUPLICATE', path: `participants.${index}.memberId` });
    }
    participantIds.add(participant.memberId);
    if (
      !Number.isInteger(participant.shares) ||
      participant.shares < 0 ||
      participant.shares > LIMITS.maxShare
    ) {
      issues.push({ code: 'PARTICIPANT_SHARE_INVALID', path: `participants.${index}.shares` });
    } else {
      shareSum += participant.shares;
    }
  });
  if (input.participants.length > 0 && shareSum !== input.participants.length) {
    issues.push({ code: 'PARTICIPANT_SHARE_SUM_INVALID', path: 'participants' });
  }

  if (input.payers.length === 0) issues.push({ code: 'PAYERS_REQUIRED', path: 'payers' });
  const payerIds = new Set<string>();
  let paidSum = 0;
  input.payers.forEach((payer, index) => {
    if (payerIds.has(payer.memberId)) {
      issues.push({ code: 'PAYER_DUPLICATE', path: `payers.${index}.memberId` });
    }
    payerIds.add(payer.memberId);
    if (!Number.isSafeInteger(payer.paidCents) || payer.paidCents < 0) {
      issues.push({ code: 'PAYER_AMOUNT_INVALID', path: `payers.${index}.paidCents` });
    } else {
      paidSum += payer.paidCents;
    }
  });
  if (input.payers.length > 0 && paidSum !== input.amountCents) {
    issues.push({ code: 'PAYER_AMOUNT_SUM_INVALID', path: 'payers' });
  }

  return issues;
}
