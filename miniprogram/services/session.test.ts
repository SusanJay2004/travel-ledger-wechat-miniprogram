import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionProfile } from './api';
import { resetAvatarStageForTest } from './avatar-upload';
import { resetPendingWritesForTest } from './api';
import {
  getLocallyCachedSessionProfile,
  getSessionProfile,
  isLocalSessionSignedOut,
  resetSessionForTest,
  resumeSessionFromWelcome,
  signOutLocalSession,
} from './session';

const SIGNED_OUT_KEY = 'local-session-signed-out-v1';
const PROFILE_KEY = 'travel-ledger-cache-v1:profile';
const profile: SessionProfile = {
  userId: 'usr_test',
  publicId: 'ABCDEFG234',
  displayName: '测试旅人',
  signature: '准备出发',
  avatarUrl: null,
  avatarReviewPending: false,
  productMode: 'solo',
};

describe('local session boundary', () => {
  beforeEach(() => {
    resetSessionForTest();
    resetPendingWritesForTest();
  });

  afterEach(() => {
    resetSessionForTest();
    resetPendingWritesForTest();
    resetAvatarStageForTest();
    vi.unstubAllGlobals();
  });

  it('fails closed after sign-out until the welcome page explicitly resumes', async () => {
    const setup = wxStub();
    setup.storage.set(SIGNED_OUT_KEY, true);
    vi.stubGlobal('wx', setup.wx);

    await expect(getSessionProfile()).rejects.toMatchObject({ code: 'LOCAL_SESSION_SIGNED_OUT' });
    expect(setup.callFunction).not.toHaveBeenCalled();

    await expect(resumeSessionFromWelcome()).resolves.toEqual(profile);
    expect(setup.callFunction).toHaveBeenCalledTimes(1);
    expect(setup.storage.has(SIGNED_OUT_KEY)).toBe(false);
    expect(getLocallyCachedSessionProfile()).toEqual(profile);
  });

  it('does not let a late bootstrap restore the session after sign-out', async () => {
    let resolveBootstrap!: (value: unknown) => void;
    let bootstrapRequestId = '';
    const setup = wxStub((options) => {
      bootstrapRequestId = requestIdFrom(options);
      return new Promise<unknown>((resolve) => {
        resolveBootstrap = resolve;
      });
    });
    vi.stubGlobal('wx', setup.wx);

    const pending = resumeSessionFromWelcome();
    await vi.waitFor(() => expect(setup.callFunction).toHaveBeenCalledTimes(1));
    expect(signOutLocalSession()).toBe(true);
    resolveBootstrap(apiSuccess(profile, bootstrapRequestId));

    await expect(pending).rejects.toThrow('登录状态已改变');
    expect(isLocalSessionSignedOut()).toBe(true);
    expect(getLocallyCachedSessionProfile()).toBeNull();
    expect(setup.storage.has(PROFILE_KEY)).toBe(false);
  });

  it('falls back to a full clear when one private-key deletion fails', () => {
    const setup = wxStub();
    setup.storage.set('privacy-consent-v1', true);
    setup.storage.set(PROFILE_KEY, { private: true });
    setup.storage.set('bill-draft-v2:usr_test:trp_1:2026-07-17', { private: true });
    setup.storage.set('unrelated-private-key', { private: true });
    setup.failRemoveKey = PROFILE_KEY;
    vi.stubGlobal('wx', setup.wx);

    expect(signOutLocalSession()).toBe(true);
    expect(setup.clearStorageSync).toHaveBeenCalledTimes(1);
    expect([...setup.storage.keys()]).toEqual(['privacy-consent-v1', SIGNED_OUT_KEY]);
  });

  it('falls back to a full clear when storage key enumeration fails', () => {
    const setup = wxStub();
    setup.storage.set('privacy-consent-v1', true);
    setup.storage.set(PROFILE_KEY, { private: true });
    setup.storage.set('unrelated-private-key', { private: true });
    setup.failStorageInfo = true;
    vi.stubGlobal('wx', setup.wx);

    expect(signOutLocalSession()).toBe(true);
    expect(setup.clearStorageSync).toHaveBeenCalledTimes(1);
    expect([...setup.storage.keys()]).toEqual(['privacy-consent-v1', SIGNED_OUT_KEY]);
  });

  it('still clears private data if the durable signed-out marker cannot be stored', () => {
    const setup = wxStub();
    setup.storage.set(PROFILE_KEY, { private: true });
    setup.storage.set('pending-api-writes-v2', [{ private: true }]);
    setup.failSetKey = SIGNED_OUT_KEY;
    vi.stubGlobal('wx', setup.wx);

    expect(signOutLocalSession()).toBe(true);
    expect(setup.clearStorageSync).toHaveBeenCalledTimes(1);
    expect(setup.storage.size).toBe(0);
    expect(isLocalSessionSignedOut()).toBe(true);
  });
});

function apiSuccess(data: SessionProfile, requestId: string): unknown {
  return { result: { ok: true, requestId, data } };
}

function wxStub(
  callFactory: (options: { data?: unknown }) => Promise<unknown> = async (options) =>
    apiSuccess(profile, requestIdFrom(options)),
) {
  const storage = new Map<string, unknown>();
  const state: {
    failRemoveKey: string | null;
    failSetKey: string | null;
    failStorageInfo: boolean;
  } = { failRemoveKey: null, failSetKey: null, failStorageInfo: false };
  const callFunction = vi.fn(async (options: { data?: unknown }) => callFactory(options));
  const clearStorageSync = vi.fn(() => storage.clear());
  const wx = {
    cloud: { callFunction },
    clearStorageSync,
    getStorageInfoSync: () => {
      if (state.failStorageInfo) throw new Error('storage info unavailable');
      return { keys: [...storage.keys()] };
    },
    getStorageSync: (key: string) => storage.get(key),
    removeStorageSync: (key: string) => {
      if (state.failRemoveKey === key) throw new Error('remove failed');
      storage.delete(key);
    },
    setStorageSync: (key: string, value: unknown) => {
      if (state.failSetKey === key) throw new Error('set failed');
      storage.set(key, structuredClone(value));
    },
  };
  return {
    callFunction,
    clearStorageSync,
    get failRemoveKey() {
      return state.failRemoveKey;
    },
    set failRemoveKey(value: string | null) {
      state.failRemoveKey = value;
    },
    get failSetKey() {
      return state.failSetKey;
    },
    set failSetKey(value: string | null) {
      state.failSetKey = value;
    },
    get failStorageInfo() {
      return state.failStorageInfo;
    },
    set failStorageInfo(value: boolean) {
      state.failStorageInfo = value;
    },
    storage,
    wx,
  };
}

function requestIdFrom(options: { data?: unknown }): string {
  if (
    typeof options.data !== 'object' ||
    options.data === null ||
    !('requestId' in options.data) ||
    typeof options.data.requestId !== 'string'
  ) {
    throw new Error('missing request id');
  }
  return options.data.requestId;
}
