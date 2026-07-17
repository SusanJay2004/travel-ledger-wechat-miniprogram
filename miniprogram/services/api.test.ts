import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, callApi, configureApiAccount, resetPendingWritesForTest } from './api';

const TEST_USER_ID = 'usr_test';
const SECOND_TEST_USER_ID = 'usr_second';
const PENDING_WRITES_KEY = 'pending-api-writes-v2';

describe('cloud API transport idempotency', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetPendingWritesForTest();
    vi.unstubAllGlobals();
  });

  it('persists and reuses a write request id until the same intent gets a definite result', async () => {
    const storage = new Map<string, unknown>();
    const calls: Array<{ data?: unknown }> = [];
    const callFunction = vi.fn(async (options: { data?: unknown }) => {
      calls.push(options);
      if (calls.length <= 2) throw new Error('callFunction:fail timeout');
      const requestId = (options.data as { requestId: string }).requestId;
      return { result: { ok: true, requestId, data: { tripId: 'trip-1' } } };
    });
    vi.stubGlobal('wx', wxStub(storage, callFunction));
    configureApiAccount(TEST_USER_ID);

    await expect(callApi('trip.create', { name: '青岛之旅' })).rejects.toMatchObject({
      code: 'TRANSPORT_RESULT_UNCERTAIN',
    });
    const firstRequestIds = calls.map((call) => (call.data as { requestId: string }).requestId);
    expect(new Set(firstRequestIds)).toHaveLength(1);

    resetPendingWritesForTest();
    configureApiAccount(TEST_USER_ID);
    await expect(callApi<{ tripId: string }>('trip.create', { name: '青岛之旅' })).resolves.toEqual(
      { tripId: 'trip-1' },
    );
    expect((calls[2]!.data as { requestId: string }).requestId).toBe(firstRequestIds[0]);
    expect(storage.has(PENDING_WRITES_KEY)).toBe(false);

    await callApi('trip.create', { name: '青岛之旅' });
    expect((calls[3]!.data as { requestId: string }).requestId).not.toBe(firstRequestIds[0]);
  });

  it('persists the write identity before handing the request to the cloud transport', async () => {
    const storage = new Map<string, unknown>();
    const callFunction = vi.fn(async (options: { data?: unknown }) => {
      const requestId = (options.data as { requestId: string }).requestId;
      expect(storage.get(PENDING_WRITES_KEY)).toEqual([
        expect.objectContaining({ action: 'trip.create', ownerUserId: TEST_USER_ID, requestId }),
      ]);
      return { result: { ok: true, requestId, data: { tripId: 'trip-1' } } };
    });
    vi.stubGlobal('wx', wxStub(storage, callFunction));
    configureApiAccount(TEST_USER_ID);

    await expect(callApi('trip.create', { name: '杭州之旅' })).resolves.toEqual({
      tripId: 'trip-1',
    });
    expect(storage.has(PENDING_WRITES_KEY)).toBe(false);
  });

  it('does not send a write when its identity cannot be stored durably', async () => {
    const callFunction = vi.fn(async () => ({ result: null }));
    vi.stubGlobal('wx', {
      cloud: { callFunction },
      getStorageSync: () => undefined,
      removeStorageSync: () => undefined,
      setStorageSync: () => {
        throw new Error('storage quota exceeded');
      },
    });
    configureApiAccount(TEST_USER_ID);

    await expect(callApi('trip.create', { name: '安全测试' })).rejects.toMatchObject({
      code: 'LOCAL_IDEMPOTENCY_STORAGE_FAILED',
    });
    expect(callFunction).not.toHaveBeenCalled();
  });

  it('coalesces concurrent matching writes so one definite result settles both callers', async () => {
    const storage = new Map<string, unknown>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const callFunction = vi.fn(async (options: { data?: unknown }) => {
      await gate;
      const requestId = (options.data as { requestId: string }).requestId;
      return { result: { ok: true, requestId, data: { tripId: 'trip-1' } } };
    });
    vi.stubGlobal('wx', wxStub(storage, callFunction));
    configureApiAccount(TEST_USER_ID);

    const first = callApi('trip.create', { name: '并发测试' });
    const second = callApi('trip.create', { name: '并发测试' });
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { tripId: 'trip-1' },
      { tripId: 'trip-1' },
    ]);
    expect(callFunction).toHaveBeenCalledTimes(1);
    expect(storage.has(PENDING_WRITES_KEY)).toBe(false);
  });

  it('treats a malformed write response as uncertain but keeps malformed reads ordinary', async () => {
    const storage = new Map<string, unknown>();
    const callFunction = vi.fn(async () => ({ result: null }));
    vi.stubGlobal('wx', wxStub(storage, callFunction));
    configureApiAccount(TEST_USER_ID);

    await expect(
      callApi('trip.create', { name: '测试' }, { transportRetries: 0 }),
    ).rejects.toMatchObject({ code: 'TRANSPORT_RESULT_UNCERTAIN' });
    expect(storage.has(PENDING_WRITES_KEY)).toBe(true);

    await expect(callApi('trip.list', {}, { transportRetries: 0 })).rejects.toThrow(
      '服务器返回了无法识别的数据',
    );
  });

  it('rejects a mismatched response id and never silently replays a stale uncertain intent', async () => {
    const now = Date.now();
    const storage = new Map<string, unknown>([
      [
        PENDING_WRITES_KEY,
        [
          {
            action: 'trip.create',
            createdAt: now - 23 * 60 * 60 * 1000,
            ownerUserId: TEST_USER_ID,
            payload: '{"name":"测试"}',
            requestId: 'old-request-id',
          },
        ],
      ],
    ]);
    const callFunction = vi.fn(async (options: { data?: unknown }) => {
      const requestId = (options.data as { requestId: string }).requestId;
      return { result: { ok: true, requestId: `${requestId}-wrong`, data: null } };
    });
    vi.stubGlobal('wx', wxStub(storage, callFunction));
    configureApiAccount(TEST_USER_ID);

    await expect(callApi('trip.create', { name: '测试' })).rejects.toMatchObject({
      code: 'STALE_UNCERTAIN_WRITE',
    });
    expect(callFunction).not.toHaveBeenCalled();

    await expect(
      callApi('trip.rename', { name: '新名称' }, { requestId: 'explicit-request-id' }),
    ).rejects.toMatchObject({ code: 'TRANSPORT_RESULT_UNCERTAIN' });
  });

  it('does not reuse an uncertain id for changed content and leaves reads as transport failures', async () => {
    const storage = new Map<string, unknown>();
    const calls: Array<{ data?: unknown }> = [];
    const callFunction = vi.fn(async (options: { data?: unknown }) => {
      calls.push(options);
      throw new Error('offline');
    });
    vi.stubGlobal('wx', wxStub(storage, callFunction));
    configureApiAccount(TEST_USER_ID);

    await expect(
      callApi('trip.addBill', { title: '早餐' }, { transportRetries: 0 }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      callApi('trip.addBill', { title: '午餐' }, { transportRetries: 0 }),
    ).rejects.toBeInstanceOf(ApiError);
    expect((calls[0]!.data as { requestId: string }).requestId).not.toBe(
      (calls[1]!.data as { requestId: string }).requestId,
    );

    await expect(callApi('trip.list', {}, { transportRetries: 0 })).rejects.toThrow('offline');
  });

  it('reuses an uncertain id when object key order changes but the write intent does not', async () => {
    const storage = new Map<string, unknown>();
    const requestIds: string[] = [];
    const callFunction = vi.fn(async (options: { data?: unknown }) => {
      requestIds.push((options.data as { requestId: string }).requestId);
      throw new Error('timeout');
    });
    vi.stubGlobal('wx', wxStub(storage, callFunction));
    configureApiAccount(TEST_USER_ID);

    await expect(
      callApi(
        'trip.updateBill',
        { tripId: 'trip-1', bill: { title: '早餐', amount: 1200 } },
        {
          transportRetries: 0,
        },
      ),
    ).rejects.toMatchObject({ code: 'TRANSPORT_RESULT_UNCERTAIN' });
    resetPendingWritesForTest();
    configureApiAccount(TEST_USER_ID);
    await expect(
      callApi(
        'trip.updateBill',
        { bill: { amount: 1200, title: '早餐' }, tripId: 'trip-1' },
        {
          transportRetries: 0,
        },
      ),
    ).rejects.toMatchObject({ code: 'TRANSPORT_RESULT_UNCERTAIN' });

    expect(requestIds[1]).toBe(requestIds[0]);
  });

  it('does not extend the safety deadline when an uncertain write is retried', async () => {
    const storage = new Map<string, unknown>();
    const callFunction = vi.fn(async () => {
      throw new Error('timeout');
    });
    vi.stubGlobal('wx', wxStub(storage, callFunction));
    configureApiAccount(TEST_USER_ID);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T00:00:00.000Z'));

    await expect(
      callApi('trip.create', { name: '测试' }, { transportRetries: 0 }),
    ).rejects.toMatchObject({ code: 'TRANSPORT_RESULT_UNCERTAIN' });
    const createdAt = pendingCreatedAt(storage);

    vi.advanceTimersByTime(22 * 60 * 60 * 1000);
    await expect(
      callApi('trip.create', { name: '测试' }, { transportRetries: 0 }),
    ).rejects.toMatchObject({ code: 'TRANSPORT_RESULT_UNCERTAIN' });
    expect(pendingCreatedAt(storage)).toBe(createdAt);

    vi.advanceTimersByTime(60 * 60 * 1000);
    await expect(callApi('trip.create', { name: '测试' })).rejects.toMatchObject({
      code: 'STALE_UNCERTAIN_WRITE',
    });
    expect(callFunction).toHaveBeenCalledTimes(2);
  });

  it('does not let a caller replace the id of an unresolved matching write', async () => {
    const storage = new Map<string, unknown>([
      [
        PENDING_WRITES_KEY,
        [
          {
            action: 'trip.create',
            createdAt: Date.now(),
            ownerUserId: TEST_USER_ID,
            payload: '{"name":"测试"}',
            requestId: 'original-request-id',
          },
        ],
      ],
    ]);
    const requestIds: string[] = [];
    const callFunction = vi.fn(async (options: { data?: unknown }) => {
      const requestId = (options.data as { requestId: string }).requestId;
      requestIds.push(requestId);
      throw new Error('timeout');
    });
    vi.stubGlobal('wx', wxStub(storage, callFunction));
    configureApiAccount(TEST_USER_ID);

    await expect(
      callApi(
        'trip.create',
        { name: '测试' },
        {
          requestId: 'replacement-request-id',
          transportRetries: 0,
        },
      ),
    ).rejects.toMatchObject({ code: 'TRANSPORT_RESULT_UNCERTAIN' });
    expect(requestIds).toEqual(['original-request-id']);
  });

  it('keeps server-side uncertain markers but clears a definitely rejected write', async () => {
    const storage = new Map<string, unknown>();
    let phase: 'transport' | 'processing' | 'rejected' = 'transport';
    const requestIds: string[] = [];
    const callFunction = vi.fn(async (options: { data?: unknown }) => {
      const requestId = (options.data as { requestId: string }).requestId;
      requestIds.push(requestId);
      if (phase === 'transport') throw new Error('timeout');
      return {
        result: {
          ok: false,
          requestId,
          error:
            phase === 'processing'
              ? { code: 'REQUEST_IN_PROGRESS', message: '处理中', retryable: true }
              : { code: 'REQUEST_INVALID', message: '已拒绝', retryable: false },
        },
      };
    });
    vi.stubGlobal('wx', wxStub(storage, callFunction));
    configureApiAccount(TEST_USER_ID);

    await expect(
      callApi('trip.create', { name: '测试' }, { transportRetries: 0 }),
    ).rejects.toMatchObject({ code: 'TRANSPORT_RESULT_UNCERTAIN' });
    phase = 'processing';
    await expect(
      callApi('trip.create', { name: '测试' }, { transportRetries: 0 }),
    ).rejects.toMatchObject({ code: 'REQUEST_IN_PROGRESS' });
    expect(requestIds[1]).toBe(requestIds[0]);

    phase = 'rejected';
    await expect(
      callApi('trip.create', { name: '测试' }, { transportRetries: 0 }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    expect(requestIds[2]).toBe(requestIds[0]);
    expect(storage.has(PENDING_WRITES_KEY)).toBe(false);
  });

  it('rejects write commands until a local account has been established', async () => {
    const storage = new Map<string, unknown>();
    const callFunction = vi.fn(async () => ({ result: null }));
    vi.stubGlobal('wx', wxStub(storage, callFunction));

    await expect(callApi('trip.create', { name: '未登录写入' })).rejects.toMatchObject({
      code: 'LOCAL_SESSION_REQUIRED',
    });
    expect(callFunction).not.toHaveBeenCalled();
    expect(storage.has(PENDING_WRITES_KEY)).toBe(false);
  });

  it('rejects non-bootstrap reads when a durable signed-out marker survives an app restart', async () => {
    const storage = new Map<string, unknown>([['local-session-signed-out-v1', true]]);
    const callFunction = vi.fn(async () => ({ result: null }));
    vi.stubGlobal('wx', wxStub(storage, callFunction));

    await expect(callApi('trip.list')).rejects.toMatchObject({ code: 'LOCAL_SESSION_REQUIRED' });
    expect(callFunction).not.toHaveBeenCalled();
  });

  it('never reuses another account pending write after an account switch', async () => {
    const storage = new Map<string, unknown>();
    const requestIds: string[] = [];
    const callFunction = vi.fn(async (options: { data?: unknown }) => {
      requestIds.push((options.data as { requestId: string }).requestId);
      throw new Error('timeout');
    });
    vi.stubGlobal('wx', wxStub(storage, callFunction));
    configureApiAccount(TEST_USER_ID);

    await expect(
      callApi('trip.create', { name: '同名行程' }, { transportRetries: 0 }),
    ).rejects.toMatchObject({ code: 'TRANSPORT_RESULT_UNCERTAIN' });
    configureApiAccount(SECOND_TEST_USER_ID);
    await expect(
      callApi('trip.create', { name: '同名行程' }, { transportRetries: 0 }),
    ).rejects.toMatchObject({ code: 'TRANSPORT_RESULT_UNCERTAIN' });

    expect(requestIds[1]).not.toBe(requestIds[0]);
    expect(storage.get(PENDING_WRITES_KEY)).toEqual([
      expect.objectContaining({ ownerUserId: SECOND_TEST_USER_ID, requestId: requestIds[1] }),
    ]);
  });

  it('does not let a late response from the previous account settle the new account state', async () => {
    const storage = new Map<string, unknown>();
    let resolveCall!: (value: unknown) => void;
    const response = new Promise<unknown>((resolve) => {
      resolveCall = resolve;
    });
    const callFunction = vi.fn(async (_options: { data?: unknown }) => response);
    vi.stubGlobal('wx', wxStub(storage, callFunction));
    configureApiAccount(TEST_USER_ID);

    const pending = callApi('trip.create', { name: '迟到响应' }, { transportRetries: 0 });
    await vi.waitFor(() => expect(callFunction).toHaveBeenCalledTimes(1));
    const requestId = (callFunction.mock.calls[0]![0].data as { requestId: string }).requestId;
    configureApiAccount(SECOND_TEST_USER_ID);
    resolveCall({ result: { ok: true, requestId, data: { tripId: 'trip-old' } } });

    await expect(pending).rejects.toMatchObject({ code: 'LOCAL_SESSION_CHANGED' });
    expect(storage.has(PENDING_WRITES_KEY)).toBe(false);
  });

  it('rejects a late read response after the local account changes', async () => {
    const storage = new Map<string, unknown>();
    let resolveCall!: (value: unknown) => void;
    const response = new Promise<unknown>((resolve) => {
      resolveCall = resolve;
    });
    const callFunction = vi.fn(async (_options: { data?: unknown }) => response);
    vi.stubGlobal('wx', wxStub(storage, callFunction));
    configureApiAccount(TEST_USER_ID);

    const pending = callApi('trip.list');
    await vi.waitFor(() => expect(callFunction).toHaveBeenCalledTimes(1));
    const requestId = (callFunction.mock.calls[0]![0].data as { requestId: string }).requestId;
    configureApiAccount(SECOND_TEST_USER_ID);
    resolveCall({ result: { ok: true, requestId, data: [] } });

    await expect(pending).rejects.toMatchObject({ code: 'LOCAL_SESSION_CHANGED' });
  });
});

function wxStub(
  storage: Map<string, unknown>,
  callFunction: (options: { data?: unknown }) => Promise<unknown>,
) {
  return {
    cloud: { callFunction },
    getStorageSync: (key: string) => storage.get(key),
    removeStorageSync: (key: string) => storage.delete(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, structuredClone(value)),
  };
}

function pendingCreatedAt(storage: Map<string, unknown>): number {
  const stored = storage.get(PENDING_WRITES_KEY) as Array<{ createdAt: number }>;
  return stored[0]!.createdAt;
}
