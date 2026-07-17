import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './api';
import {
  avatarSaveErrorMessage,
  canDiscardUploadedAvatar,
  configureAvatarUploadAccount,
  resetAvatarStageForTest,
  stageAvatar,
} from './avatar-upload';

const TEST_USER_ID = 'usr_test';
const SECOND_TEST_USER_ID = 'usr_second';
const PENDING_AVATAR_STAGE_KEY = 'pending-avatar-stage-v2';

describe('controlled avatar upload', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetAvatarStageForTest();
    vi.unstubAllGlobals();
  });

  it('rejects files above 1 MB before creating a CDN transfer or cloud call', async () => {
    const setup = wxStub({ digest: 'a'.repeat(64), size: 1024 * 1024 + 1 });
    vi.stubGlobal('wx', setup.wx);
    configureAvatarUploadAccount(TEST_USER_ID);

    await expect(stageAvatar('temp://large.jpg')).rejects.toMatchObject({
      code: 'AVATAR_TOO_LARGE',
    });
    expect(setup.cdn).not.toHaveBeenCalled();
    expect(setup.callFunction).not.toHaveBeenCalled();
  });

  it('reuses the same token and request id across uncertain retries with changing CDN URLs', async () => {
    const setup = wxStub({ digest: 'b'.repeat(64), failCalls: 1, size: 1234 });
    vi.stubGlobal('wx', setup.wx);
    configureAvatarUploadAccount(TEST_USER_ID);

    await expect(stageAvatar('temp://same.jpg')).rejects.toMatchObject({
      code: 'TRANSPORT_RESULT_UNCERTAIN',
    });
    await expect(stageAvatar('temp://same.jpg')).resolves.toMatch(/^[A-Za-z0-9-]{8,80}$/);

    const sent = setup.callFunction.mock.calls.map(([options]) => options.data);
    expect(sent[1]?.requestId).toBe(sent[0]?.requestId);
    expect(sent[1]?.payload.avatarToken).toBe(sent[0]?.payload.avatarToken);
    expect(sent[1]?.payload.sourceUrl).not.toBe(sent[0]?.payload.sourceUrl);
    expect(setup.storage.get(PENDING_AVATAR_STAGE_KEY)).toMatchObject({
      confirmed: true,
      ownerUserId: TEST_USER_ID,
    });
  });

  it('reuses a confirmed token for the same content even when the temporary path changes', async () => {
    const setup = wxStub({ digest: 'e'.repeat(64), size: 600 });
    vi.stubGlobal('wx', setup.wx);
    configureAvatarUploadAccount(TEST_USER_ID);
    const token = await stageAvatar('temp://first-path.jpg');

    await expect(stageAvatar('temp://new-path.jpg')).resolves.toBe(token);
    expect(setup.callFunction).toHaveBeenCalledTimes(1);
    expect(setup.cdn).toHaveBeenCalledTimes(1);
  });

  it('restages confirmed content after 30 minutes to preserve server expiry margin', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T08:00:00.000Z'));
    const setup = wxStub({ digest: 'f'.repeat(64), size: 600 });
    vi.stubGlobal('wx', setup.wx);
    configureAvatarUploadAccount(TEST_USER_ID);
    const first = await stageAvatar('temp://avatar.jpg');
    vi.setSystemTime(new Date('2026-07-17T08:30:00.000Z'));

    const second = await stageAvatar('temp://avatar.jpg');

    expect(second).not.toBe(first);
    expect(setup.callFunction).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('creates a new intent when the local file digest changes', async () => {
    const setup = wxStub({ digest: 'c'.repeat(64), failCalls: 1, size: 800 });
    vi.stubGlobal('wx', setup.wx);
    configureAvatarUploadAccount(TEST_USER_ID);
    await expect(stageAvatar('temp://changed.jpg')).rejects.toBeInstanceOf(ApiError);
    setup.metadata.digest = 'd'.repeat(64);
    await stageAvatar('temp://changed.jpg');

    const sent = setup.callFunction.mock.calls.map(([options]) => options.data);
    expect(sent[1]?.requestId).not.toBe(sent[0]?.requestId);
    expect(sent[1]?.payload.avatarToken).not.toBe(sent[0]?.payload.avatarToken);
  });

  it('clears an uncertain stage after 23 hours so the next attempt can create a new intent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T08:00:00.000Z'));
    const setup = wxStub({ digest: '9'.repeat(64), failCalls: 1, size: 800 });
    vi.stubGlobal('wx', setup.wx);
    configureAvatarUploadAccount(TEST_USER_ID);
    await expect(stageAvatar('temp://stale.jpg')).rejects.toMatchObject({
      code: 'TRANSPORT_RESULT_UNCERTAIN',
    });
    const first = setup.callFunction.mock.calls[0]?.[0].data;
    expect(first).toBeDefined();
    vi.setSystemTime(new Date('2026-07-18T07:00:00.000Z'));

    await expect(stageAvatar('temp://stale.jpg')).rejects.toMatchObject({
      code: 'STALE_UNCERTAIN_AVATAR_STAGE',
    });
    expect(setup.storage.has(PENDING_AVATAR_STAGE_KEY)).toBe(false);

    await expect(stageAvatar('temp://stale.jpg')).resolves.toMatch(/^[A-Za-z0-9-]{8,80}$/);
    const replacement = setup.callFunction.mock.calls[1]?.[0].data;
    expect(replacement).toBeDefined();
    if (first === undefined || replacement === undefined) throw new Error('missing stage request');
    expect(replacement.requestId).not.toBe(first.requestId);
    expect(replacement.payload.avatarToken).not.toBe(first.payload.avatarToken);
  });

  it('only discards a candidate after a definite server rejection', () => {
    expect(canDiscardUploadedAvatar(new ApiError('CONTENT_REJECTED', '拒绝', false))).toBe(true);
    expect(canDiscardUploadedAvatar(new ApiError('PROFILE_VERSION_CONFLICT', '冲突', true))).toBe(
      true,
    );
    expect(canDiscardUploadedAvatar(new ApiError('REQUEST_RESULT_UNCERTAIN', '不确定', true))).toBe(
      false,
    );
    expect(canDiscardUploadedAvatar(new ApiError('REQUEST_IN_PROGRESS', '处理中', true))).toBe(
      false,
    );
    expect(canDiscardUploadedAvatar(new Error('callFunction:fail timeout'))).toBe(false);
  });

  it('explains why an unknown transport failure keeps the staged avatar', () => {
    expect(avatarSaveErrorMessage(new Error('timeout'))).toContain('为避免误删');
    expect(avatarSaveErrorMessage(new ApiError('CONTENT_REJECTED', '请更换图片', false))).toBe(
      '请更换图片',
    );
  });

  it('rejects avatar staging until a local account has been established', async () => {
    const setup = wxStub({ digest: '1'.repeat(64), size: 500 });
    vi.stubGlobal('wx', setup.wx);

    await expect(stageAvatar('temp://signed-out.jpg')).rejects.toMatchObject({
      code: 'LOCAL_SESSION_REQUIRED',
    });
    expect(setup.cdn).not.toHaveBeenCalled();
    expect(setup.callFunction).not.toHaveBeenCalled();
  });

  it('does not reuse an avatar token or request id after an account switch', async () => {
    const setup = wxStub({ digest: '2'.repeat(64), failCalls: 1, size: 500 });
    vi.stubGlobal('wx', setup.wx);
    configureAvatarUploadAccount(TEST_USER_ID);

    await expect(stageAvatar('temp://same-content.jpg')).rejects.toMatchObject({
      code: 'TRANSPORT_RESULT_UNCERTAIN',
    });
    configureAvatarUploadAccount(SECOND_TEST_USER_ID);
    await stageAvatar('temp://same-content.jpg');

    const sent = setup.callFunction.mock.calls.map(([options]) => options.data);
    expect(sent[1]?.requestId).not.toBe(sent[0]?.requestId);
    expect(sent[1]?.payload.avatarToken).not.toBe(sent[0]?.payload.avatarToken);
    expect(setup.storage.get(PENDING_AVATAR_STAGE_KEY)).toMatchObject({
      confirmed: true,
      ownerUserId: SECOND_TEST_USER_ID,
    });
  });

  it('rejects a late avatar response from the previous account', async () => {
    let resolveCall!: (value: unknown) => void;
    const setup = wxStub({
      digest: '3'.repeat(64),
      responseFactory: () =>
        new Promise<unknown>((resolve) => {
          resolveCall = resolve;
        }),
      size: 500,
    });
    vi.stubGlobal('wx', setup.wx);
    configureAvatarUploadAccount(TEST_USER_ID);

    const pending = stageAvatar('temp://late.jpg');
    await vi.waitFor(() => expect(setup.callFunction).toHaveBeenCalledTimes(1));
    const request = setup.callFunction.mock.calls[0]?.[0].data;
    if (request === undefined) throw new Error('missing stage request');
    configureAvatarUploadAccount(SECOND_TEST_USER_ID);
    resolveCall({
      result: {
        ok: true,
        requestId: request.requestId,
        data: { avatarToken: request.payload.avatarToken },
      },
    });

    await expect(pending).rejects.toMatchObject({ code: 'LOCAL_SESSION_CHANGED' });
    expect(setup.storage.has(PENDING_AVATAR_STAGE_KEY)).toBe(false);
  });
});

interface StageRequest {
  action: string;
  payload: { avatarToken: string; sha256: string; size: number; sourceUrl: unknown };
  requestId: string;
}

function wxStub(options: {
  digest: string;
  failCalls?: number;
  responseFactory?: (request: { data: StageRequest }) => Promise<unknown>;
  size: number;
}) {
  const storage = new Map<string, unknown>();
  const metadata = { digest: options.digest, size: options.size };
  let cdnSequence = 0;
  let remainingFailures = options.failCalls ?? 0;
  const cdn = vi.fn(() => `https://cdn.test/${++cdnSequence}`);
  const callFunction = vi.fn(async (request: { data: StageRequest }) => {
    if (options.responseFactory !== undefined) return options.responseFactory(request);
    if (remainingFailures > 0) {
      remainingFailures -= 1;
      throw new Error('transport timeout');
    }
    return {
      result: {
        ok: true,
        requestId: request.data.requestId,
        data: { avatarToken: request.data.payload.avatarToken },
      },
    };
  });
  const wx = {
    cloud: { CDN: cdn, callFunction },
    getFileSystemManager: () => ({
      getFileInfo: ({ success }: { success(this: void, result: typeof metadata): void }) =>
        success({ ...metadata }),
    }),
    getStorageSync: (key: string) => storage.get(key),
    removeStorageSync: (key: string) => storage.delete(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, structuredClone(value)),
  };
  return { callFunction, cdn, metadata, storage, wx };
}
