import { describe, expect, it } from 'vitest';

import { cleanTrip } from './maintenance';

describe('cleanTrip', () => {
  const now = new Date('2026-08-20T00:00:00.000Z');

  it('detaches expired archives and permanently removes old deleted bills', () => {
    const result = cleanTrip(
      {
        version: 3,
        members: [
          {
            userId: 'alice',
            viewState: 'archived' as const,
            archivedAt: '2026-07-01T00:00:00.000Z',
            purgeAfter: '2026-08-01T00:00:00.000Z',
          },
          {
            userId: 'bob',
            viewState: 'home' as const,
            archivedAt: null,
            purgeAfter: null,
          },
        ],
        bills: [
          { id: 'old', deletedAt: '2026-07-01T00:00:00.000Z' },
          { id: 'recent', deletedAt: '2026-08-10T00:00:00.000Z' },
          { id: 'active', deletedAt: null },
        ],
      },
      now,
    );

    expect(result.detachedMemberCount).toBe(1);
    expect(result.purgedBillCount).toBe(1);
    expect(result.members[0]?.viewState).toBe('detached');
    expect(result.bills.map((bill) => bill.id)).toEqual(['recent', 'active']);
    expect(result.orphaned).toBe(false);
  });

  it('marks a trip orphaned only when every member is detached', () => {
    const result = cleanTrip(
      {
        version: 1,
        members: [
          { viewState: 'detached' as const, archivedAt: null, purgeAfter: null },
          {
            viewState: 'archived' as const,
            archivedAt: '2026-07-01T00:00:00.000Z',
            purgeAfter: '2026-08-01T00:00:00.000Z',
          },
        ],
        bills: [],
      },
      now,
    );
    expect(result.orphaned).toBe(true);
  });

  it('keeps future archives and malformed deletion timestamps for manual review', () => {
    const result = cleanTrip(
      {
        version: 1,
        members: [
          {
            viewState: 'archived' as const,
            archivedAt: '2026-08-01T00:00:00.000Z',
            purgeAfter: '2026-09-01T00:00:00.000Z',
          },
        ],
        bills: [{ deletedAt: 'invalid' }],
      },
      now,
    );
    expect(result.changed).toBe(false);
    expect(result.orphaned).toBe(false);
  });
});
