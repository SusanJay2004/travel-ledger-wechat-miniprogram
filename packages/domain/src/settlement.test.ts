import { describe, expect, it } from 'vitest';

import { calculateSettlement } from './settlement.js';
import type { BillInput } from './types.js';

const member = (memberId: string) => ({ memberId, displayName: memberId });

describe('calculateSettlement', () => {
  it('settles a payer outside the participant set', () => {
    const bill: BillInput = {
      title: '三人项目',
      amountCents: 300,
      participants: ['B', 'C', 'D'].map((id) => ({ ...member(id), shares: 1 })),
      payers: [{ ...member('A'), paidCents: 300 }],
    };

    const result = calculateSettlement([bill]);
    expect(result.transfers).toEqual([
      { fromMemberId: 'B', toMemberId: 'A', amountCents: 100 },
      { fromMemberId: 'C', toMemberId: 'A', amountCents: 100 },
      { fromMemberId: 'D', toMemberId: 'A', amountCents: 100 },
    ]);
    expect(result.minimumTransferCount).toBe(3);
  });

  it('combines multiple payers and finds fewer transfers than per-bill repayment', () => {
    const bills: BillInput[] = [
      {
        title: '第一笔',
        amountCents: 200,
        participants: ['A', 'B'].map((id) => ({ ...member(id), shares: 1 })),
        payers: [{ ...member('A'), paidCents: 200 }],
      },
      {
        title: '第二笔',
        amountCents: 200,
        participants: ['B', 'C'].map((id) => ({ ...member(id), shares: 1 })),
        payers: [
          { ...member('B'), paidCents: 50 },
          { ...member('C'), paidCents: 150 },
        ],
      },
    ];

    const result = calculateSettlement(bills);
    expect(result.balances.map(({ memberId, netCents }) => ({ memberId, netCents }))).toEqual([
      { memberId: 'A', netCents: 100 },
      { memberId: 'B', netCents: -150 },
      { memberId: 'C', netCents: 50 },
    ]);
    expect(result.transfers).toHaveLength(2);
    expect(result.transfers.reduce((sum, transfer) => sum + transfer.amountCents, 0)).toBe(150);
  });

  it('uses independent zero-sum groups to reach the exact minimum', () => {
    const bills: BillInput[] = [
      {
        title: 'AB',
        amountCents: 200,
        participants: ['A', 'B'].map((id) => ({ ...member(id), shares: 1 })),
        payers: [{ ...member('A'), paidCents: 200 }],
      },
      {
        title: 'CD',
        amountCents: 200,
        participants: ['C', 'D'].map((id) => ({ ...member(id), shares: 1 })),
        payers: [{ ...member('C'), paidCents: 200 }],
      },
    ];

    const result = calculateSettlement(bills);
    expect(result.minimumTransferCount).toBe(2);
    expect(result.transfers).toEqual([
      { fromMemberId: 'B', toMemberId: 'A', amountCents: 100 },
      { fromMemberId: 'D', toMemberId: 'C', amountCents: 100 },
    ]);
  });

  it('is deterministic when one cent must be assigned', () => {
    const bill: BillInput = {
      title: '尾差',
      amountCents: 100,
      participants: ['C', 'A', 'B'].map((id) => ({ ...member(id), shares: 1 })),
      payers: [{ ...member('C'), paidCents: 100 }],
    };
    const result = calculateSettlement([bill]);
    const nets = Object.fromEntries(
      result.balances.map((balance) => [balance.memberId, balance.netCents]),
    );
    expect(nets).toEqual({ A: -34, B: -33, C: 67 });
  });

  it('rejects invalid bills instead of silently including them', () => {
    expect(() =>
      calculateSettlement([
        {
          title: '错误份额',
          amountCents: 100,
          participants: [
            { ...member('A'), shares: 2 },
            { ...member('B'), shares: 1 },
          ],
          payers: [{ ...member('A'), paidCents: 100 }],
        },
      ]),
    ).toThrow(/PARTICIPANT_SHARE_SUM_INVALID/);
  });
});
