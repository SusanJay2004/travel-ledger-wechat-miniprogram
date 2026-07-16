import { describe, expect, it } from 'vitest';

import type { SettlementResponse, TripDetail } from './api';
import { firstInvalidBill, settlementSummary } from './settlement-view';

describe('settlement view', () => {
  it('selects the first invalid bill by date, creation time and stable id', () => {
    const trip = sampleTrip();
    trip.bills = [
      bill('later', '2026-07-11', '2026-07-10T09:00:00.000Z'),
      bill('same-date-later', '2026-07-10', '2026-07-10T10:00:00.000Z'),
      bill('first', '2026-07-10', '2026-07-10T08:00:00.000Z'),
    ];

    expect(firstInvalidBill(trip)?.id).toBe('first');
  });

  it('includes transfer lines, ignored count and amount, and ledger revision', () => {
    const settlement: SettlementResponse = {
      result: {
        transfers: [{ fromMemberId: 'bob', toMemberId: 'alice', amountCents: 1234 }],
        minimumTransferCount: 1,
      },
      ignoredBillIds: ['bill-1', 'bill-2'],
      ignoredCents: 5678,
      includedCents: 1234,
      ledgerRevision: 9,
    };

    expect(settlementSummary(sampleTrip(), settlement)).toBe(
      ['小博 给 小艾 ¥12.34', '', '纳入 ¥12.34', '已忽略 2 笔，共 ¥56.78', '账本版本 9'].join('\n'),
    );
  });
});

function sampleTrip(): TripDetail {
  return {
    id: 'trip-1',
    name: '旅行',
    status: 'active',
    members: [member('alice', '小艾'), member('bob', '小博')],
    dates: ['2026-07-10'],
    bills: [],
    totalCents: 0,
    invalidBillCount: 0,
    version: 1,
    ledgerRevision: 1,
  };
}

function member(userId: string, displayNameSnapshot: string) {
  return {
    userId,
    displayNameSnapshot,
    viewState: 'home' as const,
    archivedAt: null,
    purgeAfter: null,
  };
}

function bill(id: string, date: string, createdAt: string) {
  return {
    id,
    date,
    title: id,
    amountCents: 100,
    participants: [{ memberId: 'alice', displayName: '小艾', shares: 2 }],
    payers: [{ memberId: 'alice', displayName: '小艾', paidCents: 100 }],
    validationCodes: ['PARTICIPANT_SHARE_SUM_INVALID'],
    createdAt,
    deletedAt: null,
  };
}
