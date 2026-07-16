import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './api';
import {
  isVersionConflict,
  reconcileBillConflict,
  showVersionConflictAndRefresh,
  type ConflictMemberRow,
} from './conflict';
import type { TripDetail } from './api';

describe('version conflict handling', () => {
  const showModal = vi.fn(async (_options: ModalOptions) => ({ cancel: false, confirm: true }));

  beforeEach(() => {
    showModal.mockClear();
    vi.stubGlobal('wx', { showModal });
  });

  it('only recognizes API version conflicts', () => {
    expect(isVersionConflict(new ApiError('VERSION_CONFLICT', 'conflict', false))).toBe(true);
    expect(isVersionConflict(new ApiError('NOT_FOUND', 'missing', false))).toBe(false);
    expect(isVersionConflict(new Error('VERSION_CONFLICT'))).toBe(false);
  });

  it('explains the conflict before loading authoritative state', async () => {
    let prompted = false;
    showModal.mockImplementationOnce(async () => {
      prompted = true;
      return { cancel: false, confirm: true };
    });
    const refresh = vi.fn(async () => {
      expect(prompted).toBe(true);
    });

    await showVersionConflictAndRefresh(refresh);

    expect(refresh).toHaveBeenCalledOnce();
    const modalOptions = showModal.mock.calls[0]?.[0];
    expect(modalOptions?.title).toBe('行程已更新');
    expect(modalOptions?.content).toContain('将加载最新内容');
    expect(modalOptions?.showCancel).toBe(false);
  });

  it('reports refresh failures after the stale write has been stopped', async () => {
    const showToast = vi.fn((_options: ToastOptions) => undefined);
    vi.stubGlobal('wx', { showModal, showToast });
    const refresh = vi.fn(async () => Promise.reject(new Error('offline')));

    await expect(showVersionConflictAndRefresh(refresh)).resolves.toBeUndefined();

    expect(showModal).toHaveBeenCalledOnce();
    const toastOptions = showToast.mock.calls[0]?.[0] as { title?: string } | undefined;
    expect(toastOptions?.title).toContain('加载失败');
  });

  it('preserves draft allocations only for current members and selects a valid date', () => {
    const latest = tripFixture();
    const currentRows: readonly ConflictMemberRow[] = [
      memberRow('usr_a', '小林', true, true, '2', '18.00'),
      memberRow('usr_left', '已退出', true, false, '0', ''),
    ];

    const result = reconcileBillConflict(latest, 'bill_1', '2026-07-08', currentRows);

    expect(result.billDeleted).toBe(false);
    expect(result.date).toBe('2026-07-10');
    expect(result.dateOptions).toEqual(['2026-07-10', '2026-07-11']);
    expect(result.memberRows).toEqual([
      memberRow('usr_a', '小林', true, true, '2', '18.00'),
      memberRow('usr_new', '新成员', false, false, '1', ''),
    ]);
  });

  it('detects a remotely deleted bill without treating a new bill as deleted', () => {
    const latest = tripFixture({
      bills: [
        {
          ...tripFixture().bills[0]!,
          deletedAt: '2026-07-17T00:00:00.000Z',
        },
      ],
    });

    expect(reconcileBillConflict(latest, 'bill_1', '2026-07-10', []).billDeleted).toBe(true);
    expect(reconcileBillConflict(latest, '', '2026-07-10', []).billDeleted).toBe(false);
  });
});

function memberRow(
  userId: string,
  displayNameSnapshot: string,
  participantSelected: boolean,
  payerSelected: boolean,
  shares: string,
  paidYuan: string,
): ConflictMemberRow {
  return {
    archivedAt: null,
    displayNameSnapshot,
    paidYuan,
    participantSelected,
    payerSelected,
    purgeAfter: null,
    shares,
    userId,
    viewState: 'home',
  };
}

interface ModalOptions {
  content?: string;
  showCancel?: boolean;
  title?: string;
}

interface ToastOptions {
  title?: string;
}

function tripFixture(overrides: Partial<TripDetail> = {}): TripDetail {
  return {
    bills: [
      {
        amountCents: 1800,
        createdAt: '2026-07-10T00:00:00.000Z',
        date: '2026-07-10',
        deletedAt: null,
        id: 'bill_1',
        participants: [],
        payers: [],
        title: '午餐',
        validationCodes: [],
      },
    ],
    dates: ['2026-07-11', '2026-07-10'],
    id: 'trip_1',
    invalidBillCount: 0,
    ledgerRevision: 2,
    members: [
      memberRow('usr_a', '小林', false, false, '1', ''),
      memberRow('usr_new', '新成员', false, false, '1', ''),
      { ...memberRow('usr_detached', '已离开', false, false, '1', ''), viewState: 'detached' },
    ],
    name: '毕业旅行',
    status: 'active',
    totalCents: 1800,
    version: 3,
    ...overrides,
  };
}
