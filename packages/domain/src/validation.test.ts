import { describe, expect, it } from 'vitest';

import { isValidTripName, isValidUsername, validateBill } from './validation.js';

describe('profile and trip validation', () => {
  it('accepts the agreed character sets', () => {
    expect(isValidUsername('旅人A2026')).toBe(true);
    expect(isValidTripName('北京 2026')).toBe(true);
  });

  it('rejects special symbols and repeated spaces in trip names', () => {
    expect(isValidTripName('北京-上海')).toBe(false);
    expect(isValidTripName('北京  上海')).toBe(false);
  });
});

describe('bill validation', () => {
  it('accepts proxy shares and a payer outside participants', () => {
    expect(
      validateBill({
        title: '聚餐',
        amountCents: 30_000,
        participants: [
          { memberId: 'B', displayName: 'B', shares: 1 },
          { memberId: 'C', displayName: 'C', shares: 1 },
          { memberId: 'D', displayName: 'D', shares: 1 },
        ],
        payers: [{ memberId: 'A', displayName: 'A', paidCents: 30_000 }],
      }),
    ).toEqual([]);
  });

  it('reports share and payer sum errors independently', () => {
    const codes = validateBill({
      title: '酒店',
      amountCents: 100_00,
      participants: [
        { memberId: 'A', displayName: 'A', shares: 2 },
        { memberId: 'B', displayName: 'B', shares: 1 },
      ],
      payers: [{ memberId: 'A', displayName: 'A', paidCents: 99_00 }],
    }).map((issue) => issue.code);

    expect(codes).toContain('PARTICIPANT_SHARE_SUM_INVALID');
    expect(codes).toContain('PAYER_AMOUNT_SUM_INVALID');
  });

  it('counts emoji as one Unicode code point', () => {
    expect(
      validateBill({
        title: '😀'.repeat(12),
        amountCents: 1,
        participants: [{ memberId: 'A', displayName: 'A', shares: 1 }],
        payers: [{ memberId: 'A', displayName: 'A', paidCents: 1 }],
      }),
    ).toEqual([]);
  });

  it('rejects an individual payer amount above the bill ceiling', () => {
    const codes = validateBill({
      title: '异常金额',
      amountCents: 100,
      participants: [{ memberId: 'A', displayName: 'A', shares: 1 }],
      payers: [
        { memberId: 'A', displayName: 'A', paidCents: 1_000_000_000 },
        { memberId: 'B', displayName: 'B', paidCents: -999_999_900 },
      ],
    }).map((issue) => issue.code);

    expect(codes).toContain('PAYER_AMOUNT_INVALID');
  });
});
