import { ApiError, type TripDetail, type TripMember } from './api';

export interface ConflictMemberRow extends TripMember {
  paidYuan: string;
  participantSelected: boolean;
  payerSelected: boolean;
  shares: string;
}

export interface BillConflictResolution {
  billDeleted: boolean;
  date: string;
  dateOptions: readonly string[];
  memberRows: readonly ConflictMemberRow[];
}

export function isVersionConflict(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === 'VERSION_CONFLICT';
}

export function reconcileBillConflict(
  latest: TripDetail,
  billId: string,
  requestedDate: string,
  currentRows: readonly ConflictMemberRow[],
): BillConflictResolution {
  const existing = latest.bills.find((bill) => bill.id === billId);
  const rowsById = new Map(currentRows.map((row) => [row.userId, row]));
  const memberRows = latest.members
    .filter((member) => member.viewState !== 'detached')
    .map((member) => ({
      ...member,
      paidYuan: rowsById.get(member.userId)?.paidYuan ?? '',
      participantSelected: rowsById.get(member.userId)?.participantSelected ?? false,
      payerSelected: rowsById.get(member.userId)?.payerSelected ?? false,
      shares: rowsById.get(member.userId)?.shares ?? '1',
    }));
  const dateOptions = [...latest.dates].sort();
  const date = dateOptions.includes(requestedDate)
    ? requestedDate
    : (existing?.date ?? dateOptions[0] ?? '');
  return {
    billDeleted: billId.length > 0 && (existing === undefined || existing.deletedAt !== null),
    date,
    dateOptions,
    memberRows,
  };
}

export async function showVersionConflictAndRefresh(refresh: () => Promise<void>): Promise<void> {
  await wx.showModal({
    title: '行程已更新',
    content: '同行人刚刚修改了这段行程。将加载最新内容，请确认后再操作。',
    showCancel: false,
    confirmText: '查看最新内容',
    confirmColor: '#0F6E65',
  });
  try {
    await refresh();
  } catch {
    void wx.showToast({ icon: 'none', title: '最新内容加载失败，请检查网络后重试' });
  }
}
