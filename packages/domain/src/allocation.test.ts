import { describe, expect, it } from 'vitest';

import { allocateByShares } from './allocation.js';

describe('allocateByShares', () => {
  it('uses stable member IDs to distribute a one-cent remainder', () => {
    expect(
      allocateByShares(100, [
        { memberId: 'C', displayName: 'C', shares: 1 },
        { memberId: 'A', displayName: 'A', shares: 1 },
        { memberId: 'B', displayName: 'B', shares: 1 },
      ]),
    ).toEqual([
      { memberId: 'A', amountCents: 34 },
      { memberId: 'B', amountCents: 33 },
      { memberId: 'C', amountCents: 33 },
    ]);
  });

  it('supports zero shares and proxy responsibility', () => {
    const result = allocateByShares(10_001, [
      { memberId: 'A', displayName: 'A', shares: 3 },
      { memberId: 'B', displayName: 'B', shares: 0 },
      { memberId: 'C', displayName: 'C', shares: 0 },
      { memberId: 'D', displayName: 'D', shares: 2 },
      { memberId: 'E', displayName: 'E', shares: 0 },
    ]);

    expect(result).toEqual([
      { memberId: 'A', amountCents: 6001 },
      { memberId: 'B', amountCents: 0 },
      { memberId: 'C', amountCents: 0 },
      { memberId: 'D', amountCents: 4000 },
      { memberId: 'E', amountCents: 0 },
    ]);
    expect(result.reduce((sum, item) => sum + item.amountCents, 0)).toBe(10_001);
  });
});
