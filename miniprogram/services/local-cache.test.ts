import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionProfile, TripDetail, TripSummary } from './api';
import {
  clearLocalAccountData,
  readCachedProfile,
  readHomeTripsCache,
  readTripDetailCache,
  writeCachedProfile,
  writeHomeTripsCache,
  writeTripDetailCache,
} from './local-cache';

describe('local read-only cache', () => {
  const storage = new Map<string, unknown>();
  const profile: SessionProfile = {
    userId: 'usr_1',
    publicId: 'ABCDEFG234',
    displayName: '旅人',
    signature: '出发',
    avatarUrl: null,
    avatarReviewPending: false,
    productMode: 'solo',
  };

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal('wx', {
      getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
      getStorageSync: (key: string) => storage.get(key),
      removeStorageSync: (key: string) => storage.delete(key),
      setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    });
  });

  it('isolates home and trip caches by account', () => {
    const trips: readonly TripSummary[] = [
      {
        id: 'trp_1',
        name: '海边',
        status: 'active',
        startDate: '2026-07-10',
        endDate: '2026-07-10',
        totalCents: 1200,
        invalidBillCount: 0,
        ledgerRevision: 1,
      },
    ];
    const detail: TripDetail = {
      id: 'trp_1',
      name: '海边',
      status: 'active',
      members: [],
      dates: ['2026-07-10'],
      bills: [],
      totalCents: 1200,
      invalidBillCount: 0,
      version: 2,
      ledgerRevision: 1,
    };

    writeCachedProfile(profile);
    writeHomeTripsCache(profile.userId, trips);
    writeTripDetailCache(profile.userId, detail);

    expect(readCachedProfile()?.value).toEqual(profile);
    expect(readHomeTripsCache(profile.userId)?.value).toEqual(trips);
    expect(readHomeTripsCache('usr_2')).toBeNull();
    expect(readTripDetailCache(detail.id, profile.userId)?.value).toEqual(detail);
    expect(readTripDetailCache(detail.id, 'usr_2')).toBeNull();
  });

  it('clears account caches and drafts without removing privacy consent', () => {
    writeCachedProfile(profile);
    storage.set('bill-draft-v1:trp_1:2026-07-10', { title: '草稿' });
    storage.set('privacy-consent-v1', true);

    clearLocalAccountData();

    expect(readCachedProfile()).toBeNull();
    expect(storage.has('bill-draft-v1:trp_1:2026-07-10')).toBe(false);
    expect(storage.get('privacy-consent-v1')).toBe(true);
  });
});
