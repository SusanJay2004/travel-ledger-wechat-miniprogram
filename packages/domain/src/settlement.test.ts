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

  it('settles the 20-member 100-bill limit within two seconds', () => {
    const members = Array.from({ length: 20 }, (_, index) => `M${String(index).padStart(2, '0')}`);
    const bills: BillInput[] = Array.from({ length: 100 }, (_, index) => ({
      title: `账单${index}`,
      amountCents: 2_000,
      participants: members.map((id) => ({ ...member(id), shares: 1 })),
      payers: [{ ...member(members[0]!), paidCents: 2_000 }],
    }));
    const startedAt = performance.now();
    const result = calculateSettlement(bills);
    const durationMs = performance.now() - startedAt;

    expect(result.minimumTransferCount).toBe(19);
    expect(result.transfers.reduce((sum, transfer) => sum + transfer.amountCents, 0)).toBe(190_000);
    expect(durationMs).toBeLessThan(2_000);
  }, 5_000);

  it('matches an independent exhaustive minimum for deterministic small random balances', () => {
    const random = mulberry32(0x5eed2026);
    for (let sample = 0; sample < 120; sample += 1) {
      const memberCount = 2 + Math.floor(random() * 7);
      const paid = Array.from({ length: memberCount }, () => Math.floor(random() * 500));
      const total = paid.reduce((sum, value) => sum + value, 0);
      if (total === 0) {
        sample -= 1;
        continue;
      }
      const bill: BillInput = {
        title: `随机${sample}`,
        amountCents: total,
        participants: Array.from({ length: memberCount }, (_, index) => ({
          ...member(`M${index}`),
          shares: 1,
        })),
        payers: paid
          .map((paidCents, index) => ({ ...member(`M${index}`), paidCents }))
          .filter((payer) => payer.paidCents > 0),
      };

      const result = calculateSettlement([bill]);
      const nonZeroBalances = result.balances.filter((balance) => balance.netCents !== 0);
      expect(result.minimumTransferCount).toBe(
        exhaustiveMinimumTransferCount(nonZeroBalances.map((balance) => balance.netCents)),
      );
      const transferNet = new Map(result.balances.map((balance) => [balance.memberId, 0]));
      for (const transfer of result.transfers) {
        transferNet.set(
          transfer.fromMemberId,
          (transferNet.get(transfer.fromMemberId) ?? 0) - transfer.amountCents,
        );
        transferNet.set(
          transfer.toMemberId,
          (transferNet.get(transfer.toMemberId) ?? 0) + transfer.amountCents,
        );
      }
      expect(result.balances.map((balance) => transferNet.get(balance.memberId) ?? 0)).toEqual(
        result.balances.map((balance) => balance.netCents),
      );
    }
  });
});

function exhaustiveMinimumTransferCount(balances: readonly number[]): number {
  if (balances.length === 0) return 0;
  const fullMask = (1 << balances.length) - 1;
  const sums = new Int32Array(fullMask + 1);
  for (let mask = 1; mask <= fullMask; mask += 1) {
    const bit = mask & -mask;
    const index = 31 - Math.clz32(bit);
    sums[mask] = sums[mask ^ bit]! + balances[index]!;
  }
  const maximumGroups = new Int8Array(fullMask + 1);
  maximumGroups.fill(-1);
  maximumGroups[0] = 0;
  for (let mask = 1; mask <= fullMask; mask += 1) {
    const firstBit = mask & -mask;
    for (let subset = mask; subset > 0; subset = (subset - 1) & mask) {
      if ((subset & firstBit) === 0 || sums[subset] !== 0) continue;
      const remainderGroups = maximumGroups[mask ^ subset]!;
      if (remainderGroups >= 0) {
        maximumGroups[mask] = Math.max(maximumGroups[mask]!, remainderGroups + 1);
      }
    }
  }
  const groups = maximumGroups[fullMask]!;
  if (groups < 1) throw new Error('Exhaustive zero-sum partition invariant failed.');
  return balances.length - groups;
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
