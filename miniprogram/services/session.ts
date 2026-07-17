import { callApi, clearPendingApiWrites, type SessionProfile } from './api';
import { configureRuntimeMode } from '../config/runtime';
import { clearLocalAccountData, readCachedProfile, writeCachedProfile } from './local-cache';

let cachedProfile: SessionProfile | null = null;
let pendingProfile: Promise<SessionProfile> | null = null;
const SIGNED_OUT_KEY = 'local-session-signed-out-v1';

export function getSessionProfile(forceRefresh = false): Promise<SessionProfile> {
  if (!forceRefresh && cachedProfile !== null) return Promise.resolve(cachedProfile);
  if (!forceRefresh && pendingProfile !== null) return pendingProfile;

  const request = callApi<SessionProfile>('session.bootstrap')
    .then((profile) => {
      configureRuntimeMode(profile.productMode);
      cachedProfile = profile;
      writeCachedProfile(profile);
      removeSignedOutMarker();
      return profile;
    })
    .finally(() => {
      if (pendingProfile === request) pendingProfile = null;
    });
  pendingProfile = request;
  return request;
}

export function updateCachedSessionProfile(profile: SessionProfile): void {
  configureRuntimeMode(profile.productMode);
  cachedProfile = profile;
  writeCachedProfile(profile);
  removeSignedOutMarker();
}

export function clearCachedSessionProfile(): void {
  cachedProfile = null;
  pendingProfile = null;
}

export function getLocallyCachedSessionProfile(): SessionProfile | null {
  if (cachedProfile !== null) return cachedProfile;
  const stored = readCachedProfile()?.value ?? null;
  if (stored !== null) configureRuntimeMode(stored.productMode);
  return stored;
}

export function isLocalSessionSignedOut(): boolean {
  try {
    return wx.getStorageSync<boolean>(SIGNED_OUT_KEY) === true;
  } catch {
    return false;
  }
}

export function signOutLocalSession(): void {
  wx.setStorageSync(SIGNED_OUT_KEY, true);
  clearCachedSessionProfile();
  clearPendingApiWrites();
  clearLocalAccountData();
}

function removeSignedOutMarker(): void {
  try {
    wx.removeStorageSync(SIGNED_OUT_KEY);
  } catch {
    // The cloud session is still valid even when optional local storage is unavailable.
  }
}
