import {
  ApiError,
  callApi,
  clearPendingApiWrites,
  configureApiAccount,
  type SessionProfile,
} from './api';
import { configureRuntimeMode } from '../config/runtime';
import {
  clearAllLocalStorage,
  clearLocalAccountData,
  readCachedProfile,
  writeCachedProfile,
} from './local-cache';
import { clearAvatarUploadAccount, configureAvatarUploadAccount } from './avatar-upload';

let cachedProfile: SessionProfile | null = null;
let pendingProfile: Promise<SessionProfile> | null = null;
let sessionGeneration = 0;
let signedOutInMemory = false;
const SIGNED_OUT_KEY = 'local-session-signed-out-v1';

export function getSessionProfile(forceRefresh = false): Promise<SessionProfile> {
  return loadSessionProfile(forceRefresh, false);
}

export function resumeSessionFromWelcome(): Promise<SessionProfile> {
  return loadSessionProfile(true, true);
}

function loadSessionProfile(
  forceRefresh: boolean,
  allowSignedOutResume: boolean,
): Promise<SessionProfile> {
  if (!allowSignedOutResume && isLocalSessionSignedOut()) {
    return Promise.reject(
      new ApiError('LOCAL_SESSION_SIGNED_OUT', '当前已退出登录，请从欢迎页重新进入。', false),
    );
  }
  if (!forceRefresh && cachedProfile !== null) return Promise.resolve(cachedProfile);
  if (!forceRefresh && pendingProfile !== null) return pendingProfile;

  const generation = sessionGeneration;
  const request = callApi<SessionProfile>('session.bootstrap')
    .then((profile) => {
      if (generation !== sessionGeneration) throw new Error('登录状态已改变，请重新进入。');
      configureAccountServices(profile.userId);
      configureRuntimeMode(profile.productMode);
      cachedProfile = profile;
      signedOutInMemory = false;
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
  configureAccountServices(profile.userId);
  configureRuntimeMode(profile.productMode);
  cachedProfile = profile;
  signedOutInMemory = false;
  writeCachedProfile(profile);
  removeSignedOutMarker();
}

export function clearCachedSessionProfile(): void {
  sessionGeneration += 1;
  cachedProfile = null;
  pendingProfile = null;
}

export function getLocallyCachedSessionProfile(): SessionProfile | null {
  if (isLocalSessionSignedOut()) return null;
  if (cachedProfile !== null) return cachedProfile;
  const stored = readCachedProfile()?.value ?? null;
  if (stored !== null) configureRuntimeMode(stored.productMode);
  return stored;
}

export function isLocalSessionSignedOut(): boolean {
  if (cachedProfile !== null) return false;
  if (signedOutInMemory) return true;
  try {
    return wx.getStorageSync<boolean>(SIGNED_OUT_KEY) === true;
  } catch {
    return true;
  }
}

export function signOutLocalSession(): boolean {
  signedOutInMemory = true;
  clearCachedSessionProfile();
  clearPendingApiWrites();
  clearAvatarUploadAccount();
  const accountDataCleared = clearLocalAccountData();
  let markerStored = false;
  try {
    wx.setStorageSync(SIGNED_OUT_KEY, true);
    markerStored = true;
  } catch {
    // Fall back to clearing all local storage below.
  }
  if (markerStored) return accountDataCleared;

  // If the durable signed-out marker cannot be written, removing all storage also
  // removes privacy consent. On the next launch the app must return to the welcome
  // page instead of silently bootstrapping the previous WeChat identity.
  try {
    wx.removeStorageSync('privacy-consent-v1');
  } catch {
    // The caller will warn that manual storage cleanup is still required.
  }
  return clearAllLocalStorage();
}

export function resetSessionForTest(): void {
  sessionGeneration += 1;
  cachedProfile = null;
  pendingProfile = null;
  signedOutInMemory = false;
}

function removeSignedOutMarker(): void {
  try {
    wx.removeStorageSync(SIGNED_OUT_KEY);
  } catch {
    // The cloud session is still valid even when optional local storage is unavailable.
  }
}

function configureAccountServices(userId: string): void {
  configureApiAccount(userId);
  configureAvatarUploadAccount(userId);
}
