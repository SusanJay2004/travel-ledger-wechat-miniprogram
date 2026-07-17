import type { SessionProfile, TripDetail, TripSummary } from './api';

export interface CachedValue<T> {
  savedAt: string;
  value: T;
}

interface CacheEnvelope<T> extends CachedValue<T> {
  version: 1;
}

const CACHE_PREFIX = 'travel-ledger-cache-v1:';
const PROFILE_KEY = `${CACHE_PREFIX}profile`;
const HOME_PREFIX = `${CACHE_PREFIX}home:`;
const TRIP_PREFIX = `${CACHE_PREFIX}trip:`;
const ACCOUNT_STORAGE_PREFIXES = [CACHE_PREFIX, 'bill-draft-v1:', 'bill-draft-v2:'] as const;
const ACCOUNT_STORAGE_KEYS = [
  'pending-launch-v1',
  'pending-api-writes-v1',
  'pending-api-writes-v2',
  'pending-avatar-stage-v1',
  'pending-avatar-stage-v2',
] as const;
const PRIVACY_CONSENT_KEY = 'privacy-consent-v1';
const MAX_TRIP_CACHE_ENTRIES = 12;

export function writeCachedProfile(profile: SessionProfile): void {
  writeEnvelope(PROFILE_KEY, profile);
}

export function readCachedProfile(): CachedValue<SessionProfile> | null {
  return readEnvelope(PROFILE_KEY, isSessionProfile);
}

export function writeHomeTripsCache(userId: string, trips: readonly TripSummary[]): void {
  writeEnvelope(`${HOME_PREFIX}${userId}`, trips);
}

export function readHomeTripsCache(userId: string): CachedValue<readonly TripSummary[]> | null {
  return readEnvelope(`${HOME_PREFIX}${userId}`, isTripSummaryList);
}

export function writeTripDetailCache(userId: string, trip: TripDetail): void {
  writeEnvelope(`${TRIP_PREFIX}${userId}:${trip.id}`, trip);
  pruneTripCaches();
}

export function readTripDetailCache(
  tripId: string,
  userId: string,
): CachedValue<TripDetail> | null {
  return readEnvelope(`${TRIP_PREFIX}${userId}:${tripId}`, isTripDetail);
}

export function clearLocalAccountData(): boolean {
  const privacyConsented = readPrivacyConsent();
  const keys = cacheKeys();
  if (keys === null) return clearAllLocalData(privacyConsented);
  const accountKeys = new Set<string>(ACCOUNT_STORAGE_KEYS);
  for (const key of keys) {
    if (ACCOUNT_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) accountKeys.add(key);
  }
  let complete = true;
  for (const key of accountKeys) {
    try {
      wx.removeStorageSync(key);
    } catch {
      complete = false;
    }
  }
  if (!complete) return clearAllLocalData(privacyConsented);
  return true;
}

export function clearAllLocalStorage(): boolean {
  try {
    wx.clearStorageSync();
    return true;
  } catch {
    return false;
  }
}

function clearAllLocalData(privacyConsented: boolean): boolean {
  if (!clearAllLocalStorage()) return false;
  if (privacyConsented) {
    try {
      wx.setStorageSync(PRIVACY_CONSENT_KEY, true);
    } catch {
      // Losing a non-sensitive preference is safer than retaining account data.
    }
  }
  return true;
}

export function formatCacheTime(savedAt: string): string {
  const date = new Date(savedAt);
  if (Number.isNaN(date.getTime())) return '较早前';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function writeEnvelope<T>(key: string, value: T): void {
  const envelope: CacheEnvelope<T> = {
    version: 1,
    savedAt: new Date().toISOString(),
    value,
  };
  try {
    wx.setStorageSync(key, envelope);
  } catch {
    // Cache writes are optional and must never make an online operation fail.
  }
}

function readEnvelope<T>(
  key: string,
  validate: (value: unknown) => value is T,
): CachedValue<T> | null {
  try {
    const stored = wx.getStorageSync<unknown>(key);
    if (!isRecord(stored) || stored['version'] !== 1) return null;
    const savedAt = stored['savedAt'];
    const value = stored['value'];
    if (typeof savedAt !== 'string' || !validate(value)) return null;
    return { savedAt, value };
  } catch {
    return null;
  }
}

function pruneTripCaches(): void {
  const entries = (cacheKeys() ?? [])
    .filter((key) => key.startsWith(TRIP_PREFIX))
    .map((key) => ({ key, savedAt: readSavedAt(key) }))
    .sort((left, right) => right.savedAt.localeCompare(left.savedAt));
  for (const entry of entries.slice(MAX_TRIP_CACHE_ENTRIES)) {
    try {
      wx.removeStorageSync(entry.key);
    } catch {
      // Best-effort LRU pruning only.
    }
  }
}

function readSavedAt(key: string): string {
  try {
    const stored = wx.getStorageSync<unknown>(key);
    return isRecord(stored) && typeof stored['savedAt'] === 'string' ? stored['savedAt'] : '';
  } catch {
    return '';
  }
}

function cacheKeys(): readonly string[] | null {
  try {
    return wx.getStorageInfoSync().keys;
  } catch {
    return null;
  }
}

function readPrivacyConsent(): boolean {
  try {
    return wx.getStorageSync<boolean>(PRIVACY_CONSENT_KEY) === true;
  } catch {
    return false;
  }
}

function isSessionProfile(value: unknown): value is SessionProfile {
  return (
    isRecord(value) &&
    typeof value['userId'] === 'string' &&
    typeof value['publicId'] === 'string' &&
    typeof value['displayName'] === 'string' &&
    typeof value['signature'] === 'string' &&
    (value['avatarUrl'] === null || typeof value['avatarUrl'] === 'string') &&
    typeof value['avatarReviewPending'] === 'boolean' &&
    (value['productMode'] === 'solo' || value['productMode'] === 'collaboration')
  );
}

function isTripSummaryList(value: unknown): value is readonly TripSummary[] {
  return Array.isArray(value) && value.every(isTripSummary);
}

function isTripSummary(value: unknown): value is TripSummary {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['name'] === 'string' &&
    (value['status'] === 'active' || value['status'] === 'completed') &&
    (value['startDate'] === null || typeof value['startDate'] === 'string') &&
    (value['endDate'] === null || typeof value['endDate'] === 'string') &&
    typeof value['totalCents'] === 'number' &&
    typeof value['invalidBillCount'] === 'number' &&
    typeof value['ledgerRevision'] === 'number'
  );
}

function isTripDetail(value: unknown): value is TripDetail {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['name'] === 'string' &&
    (value['status'] === 'active' || value['status'] === 'completed') &&
    Array.isArray(value['members']) &&
    Array.isArray(value['dates']) &&
    value['dates'].every((date) => typeof date === 'string') &&
    Array.isArray(value['bills']) &&
    typeof value['totalCents'] === 'number' &&
    typeof value['invalidBillCount'] === 'number' &&
    typeof value['version'] === 'number' &&
    typeof value['ledgerRevision'] === 'number'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
