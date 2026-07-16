import { allocateByShares } from './allocation.js';
import { validateBill } from './validation.js';
import type {
  BillInput,
  MemberBalance,
  MemberSnapshot,
  SettlementResult,
  Transfer,
} from './types.js';

interface MutableBalance extends MemberSnapshot {
  paidCents: number;
  owedCents: number;
  netCents: number;
}

interface WorkingAmount {
  memberId: string;
  amountCents: number;
}

export function calculateSettlement(bills: readonly BillInput[]): SettlementResult {
  const balances = new Map<string, MutableBalance>();

  for (const bill of bills) {
    const issues = validateBill(bill);
    if (issues.length > 0) {
      throw new RangeError(
        `Cannot settle an invalid bill: ${issues.map((issue) => issue.code).join(', ')}`,
      );
    }

    for (const participant of bill.participants) {
      ensureBalance(balances, participant);
    }
    for (const payer of bill.payers) {
      const balance = ensureBalance(balances, payer);
      balance.paidCents += payer.paidCents;
    }
    for (const allocation of allocateByShares(bill.amountCents, bill.participants)) {
      const balance = balances.get(allocation.memberId);
      if (balance === undefined) throw new Error('Participant balance invariant failed.');
      balance.owedCents += allocation.amountCents;
    }
  }

  const finalized: MemberBalance[] = [...balances.values()]
    .map((balance) => ({
      ...balance,
      netCents: balance.paidCents - balance.owedCents,
    }))
    .sort((left, right) => left.memberId.localeCompare(right.memberId));

  const netTotal = finalized.reduce((sum, balance) => sum + balance.netCents, 0);
  if (netTotal !== 0) throw new Error('Settlement does not conserve cents.');

  const nonZero = finalized.filter((balance) => balance.netCents !== 0);
  const groups = findMaximumZeroSumGroups(nonZero);
  const transfers = groups.flatMap((group) => settleZeroSumGroup(group));

  return {
    balances: finalized,
    transfers,
    minimumTransferCount: transfers.length,
  };
}

function ensureBalance(
  balances: Map<string, MutableBalance>,
  member: MemberSnapshot,
): MutableBalance {
  const existing = balances.get(member.memberId);
  if (existing !== undefined) return existing;

  const created: MutableBalance = {
    memberId: member.memberId,
    displayName: member.displayName,
    paidCents: 0,
    owedCents: 0,
    netCents: 0,
  };
  balances.set(member.memberId, created);
  return created;
}

function findMaximumZeroSumGroups(
  balances: readonly MemberBalance[],
): readonly (readonly MemberBalance[])[] {
  const count = balances.length;
  if (count === 0) return [];
  if (count > 20) throw new RangeError('Exact settlement supports at most 20 non-zero balances.');

  const stateCount = 1 << count;
  const sums = new Float64Array(stateCount);
  const groupCounts = new Uint8Array(stateCount);
  const choices = new Int8Array(stateCount);
  choices.fill(-1);

  for (let mask = 1; mask < stateCount; mask += 1) {
    const bit = mask & -mask;
    const index = 31 - Math.clz32(bit);
    const balance = balances[index];
    if (balance === undefined) throw new Error('Balance mask invariant failed.');
    sums[mask] = typedArrayValue(sums, mask ^ bit) + balance.netCents;
  }

  for (let mask = 1; mask < stateCount; mask += 1) {
    const bonus = typedArrayValue(sums, mask) === 0 ? 1 : 0;
    let remaining = mask;
    let best = -1;
    let bestIndex = -1;
    while (remaining !== 0) {
      const bit = remaining & -remaining;
      const index = 31 - Math.clz32(bit);
      const candidate = typedArrayValue(groupCounts, mask ^ bit) + bonus;
      if (candidate > best) {
        best = candidate;
        bestIndex = index;
      }
      remaining ^= bit;
    }
    groupCounts[mask] = best;
    choices[mask] = bestIndex;
  }

  const groups: MemberBalance[][] = [];
  let currentGroup: MemberBalance[] = [];
  let mask = stateCount - 1;
  while (mask !== 0) {
    const index = typedArrayValue(choices, mask);
    if (index < 0) throw new Error('Settlement reconstruction invariant failed.');
    const balance = balances[index];
    if (balance === undefined) throw new Error('Settlement balance invariant failed.');
    currentGroup.push(balance);
    mask ^= 1 << index;
    if (typedArrayValue(sums, mask) === 0) {
      groups.push(currentGroup);
      currentGroup = [];
    }
  }
  if (currentGroup.length !== 0) throw new Error('Zero-sum group invariant failed.');
  return groups;
}

function typedArrayValue(values: Float64Array | Uint8Array | Int8Array, index: number): number {
  const value = values[index];
  if (value === undefined) throw new Error('Typed array index invariant failed.');
  return value;
}

function settleZeroSumGroup(group: readonly MemberBalance[]): readonly Transfer[] {
  const debtors: WorkingAmount[] = group
    .filter((balance) => balance.netCents < 0)
    .map((balance) => ({ memberId: balance.memberId, amountCents: -balance.netCents }))
    .sort((left, right) => left.memberId.localeCompare(right.memberId));
  const creditors: WorkingAmount[] = group
    .filter((balance) => balance.netCents > 0)
    .map((balance) => ({ memberId: balance.memberId, amountCents: balance.netCents }))
    .sort((left, right) => left.memberId.localeCompare(right.memberId));

  const transfers: Transfer[] = [];
  let debtorIndex = 0;
  let creditorIndex = 0;
  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    if (debtor === undefined || creditor === undefined) {
      throw new Error('Settlement matching invariant failed.');
    }
    const amountCents = Math.min(debtor.amountCents, creditor.amountCents);
    transfers.push({
      fromMemberId: debtor.memberId,
      toMemberId: creditor.memberId,
      amountCents,
    });
    debtor.amountCents -= amountCents;
    creditor.amountCents -= amountCents;
    if (debtor.amountCents === 0) debtorIndex += 1;
    if (creditor.amountCents === 0) creditorIndex += 1;
  }

  if (
    debtors.some((debtor) => debtor.amountCents !== 0) ||
    creditors.some((creditor) => creditor.amountCents !== 0)
  ) {
    throw new Error('Settlement matching did not conserve cents.');
  }
  return transfers;
}
