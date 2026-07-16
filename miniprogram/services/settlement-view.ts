import type { SettlementResponse, TripBill, TripDetail } from './api';

export function firstInvalidBill(trip: TripDetail): TripBill | undefined {
  return trip.bills
    .filter((bill) => bill.deletedAt === null && bill.validationCodes.length > 0)
    .sort(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    )[0];
}

export function settlementSummary(trip: TripDetail, settlement: SettlementResponse): string {
  const nameById = Object.fromEntries(
    trip.members.map((member) => [member.userId, member.displayNameSnapshot]),
  );
  const lines = settlement.result.transfers.map(
    (transfer) =>
      `${nameById[transfer.fromMemberId] ?? '成员'} 给 ${nameById[transfer.toMemberId] ?? '成员'} ${formatCents(transfer.amountCents)}`,
  );
  return [
    ...(lines.length > 0 ? lines : ['大家已经结清，无需转账。']),
    '',
    `纳入 ${formatCents(settlement.includedCents)}`,
    settlement.ignoredBillIds.length > 0
      ? `已忽略 ${settlement.ignoredBillIds.length} 笔，共 ${formatCents(settlement.ignoredCents)}`
      : '没有忽略账单',
    `账本版本 ${settlement.ledgerRevision}`,
  ].join('\n');
}

export function completionPrompt(trip: TripDetail, settlement: SettlementResponse) {
  const invalidBill = firstInvalidBill(trip);
  const hasIgnoredBills = settlement.ignoredBillIds.length > 0;
  return {
    cancelText: invalidBill === undefined ? '取消' : '去修改',
    confirmText: hasIgnoredBills ? '忽略并完结' : '确认完结',
    content: `${settlementSummary(trip, settlement)}\n\n完结后账本会变为只读，仍可重新开启。`,
    ignoreInvalidBills: hasIgnoredBills,
    invalidBill,
    title: hasIgnoredBills
      ? `${settlement.ignoredBillIds.length} 笔账单将被忽略`
      : '确认最新分账并完结？',
  };
}

function formatCents(value: number): string {
  return `¥${(value / 100).toFixed(2)}`;
}
