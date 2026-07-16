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

  it('conserves every cent and is independent of input order across random valid shares', () => {
    const random = mulberry32(0xa110ca7e);
    for (let sample = 0; sample < 500; sample += 1) {
      const participantCount = 1 + Math.floor(random() * 20);
      const shares = randomShares(participantCount, random);
      const amountCents = 1 + Math.floor(random() * 999_999_900);
      const participants = shares.map((share, index) => ({
        memberId: `M${String(index).padStart(2, '0')}`,
        displayName: `成员${index}`,
        shares: share,
      }));

      const allocation = allocateByShares(amountCents, participants);
      const reversed = allocateByShares(amountCents, [...participants].reverse());
      expect(allocation).toEqual(reversed);
      expect(allocation.reduce((sum, item) => sum + item.amountCents, 0)).toBe(amountCents);
      for (const item of allocation) {
        const participant = participants.find((entry) => entry.memberId === item.memberId)!;
        expect(item.amountCents).toBeGreaterThanOrEqual(0);
        if (participant.shares === 0) expect(item.amountCents).toBe(0);
      }
    }
  });
});

function randomShares(count: number, random: () => number): number[] {
  const shares = Array.from({ length: count }, () => 0);
  for (let unit = 0; unit < count; unit += 1) {
    shares[Math.floor(random() * count)]! += 1;
  }
  return shares;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
