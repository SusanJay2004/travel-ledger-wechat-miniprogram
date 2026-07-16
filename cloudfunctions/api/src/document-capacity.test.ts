import { describe, expect, it } from 'vitest';

import type { BillDocument, TripDocument } from './models';

describe('embedded trip document capacity', () => {
  it('keeps the conservative 20-member / 500-retained-bill sample below 4 MiB JSON', () => {
    const members = Array.from({ length: 20 }, (_, index) => ({
      userId: `usr_${String(index).padStart(32, 'f')}`,
      displayNameSnapshot: '旅'.repeat(16),
      joinedAt: '2026-07-17T12:34:56.789Z',
      viewState: 'home' as const,
      archivedAt: null,
      purgeAfter: null,
    }));
    const bills = Array.from({ length: 500 }, (_, index) =>
      maximumBill(index, members, index >= 100),
    );
    const trip: TripDocument = {
      id: `trp_${'f'.repeat(32)}`,
      name: '旅'.repeat(20),
      status: 'active',
      memberIds: members.map((member) => member.userId),
      members,
      dates: Array.from(
        { length: 100 },
        (_, index) =>
          `2026-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}`,
      ),
      bills,
      totalCents: 999_999_900 * 100,
      invalidBillCount: 0,
      version: 9999,
      ledgerRevision: 9999,
      projectionOutbox: Array.from({ length: 1000 }, (_, index) => ({
        id: `out_${String(index).padStart(32, 'f')}`,
        action: 'bill.updated',
        actorUserId: members[0]!.userId,
        entityType: 'bill' as const,
        entityId: `bil_${String(index).padStart(32, 'f')}`,
        beforeVersion: index,
        afterVersion: index + 1,
        ledgerRevision: index + 1,
        targetUserIds: members.map((member) => member.userId),
        createdAt: '2026-07-17T12:34:56.789Z',
      })),
      createdBy: members[0]!.userId,
      createdAt: '2026-07-17T12:34:56.789Z',
      updatedBy: members[0]!.userId,
      updatedAt: '2026-07-17T12:34:56.789Z',
      completedAt: null,
      completedBy: null,
    };

    const jsonBytes = Buffer.byteLength(JSON.stringify(trip), 'utf8');
    expect(jsonBytes).toBeLessThan(4 * 1024 * 1024);
  });
});

function maximumBill(
  index: number,
  members: TripDocument['members'],
  deleted: boolean,
): BillDocument {
  const amountCents = 999_999_900;
  const basePaid = Math.floor(amountCents / members.length);
  const remainder = amountCents - basePaid * members.length;
  return {
    id: `bil_${String(index).padStart(32, 'f')}`,
    date: '2026-07-17',
    title: '餐'.repeat(12),
    amountCents,
    participants: members.map((member) => ({
      memberId: member.userId,
      displayName: member.displayNameSnapshot,
      shares: 1,
    })),
    payers: members.map((member, payerIndex) => ({
      memberId: member.userId,
      displayName: member.displayNameSnapshot,
      paidCents: basePaid + (payerIndex < remainder ? 1 : 0),
    })),
    validationCodes: [],
    createdBy: members[0]!.userId,
    createdAt: '2026-07-17T12:34:56.789Z',
    updatedBy: members[0]!.userId,
    updatedAt: '2026-07-17T12:34:56.789Z',
    deletedAt: deleted ? '2026-07-16T12:34:56.789Z' : null,
    deletedBy: deleted ? members[0]!.userId : null,
  };
}
