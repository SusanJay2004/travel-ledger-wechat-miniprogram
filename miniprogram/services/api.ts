export interface ApiSuccess<T> {
  ok: true;
  data: T;
  requestId: string;
}

export interface ApiFailure {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Readonly<Record<string, unknown>>;
  };
  requestId: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface TripSummary {
  id: string;
  name: string;
  status: 'active' | 'completed';
  startDate: string | null;
  endDate: string | null;
  totalCents: number;
  invalidBillCount: number;
  ledgerRevision: number;
}

export interface SessionProfile {
  userId: string;
  publicId: string;
  displayName: string;
  signature: string;
  avatarUrl: string | null;
  avatarReviewPending: boolean;
  productMode: 'solo' | 'collaboration';
}

export interface TripMember {
  userId: string;
  displayNameSnapshot: string;
  viewState: 'home' | 'archived' | 'detached';
  archivedAt: string | null;
  purgeAfter: string | null;
}

export interface BillParticipant {
  memberId: string;
  displayName: string;
  shares: number;
}

export interface BillPayer {
  memberId: string;
  displayName: string;
  paidCents: number;
}

export interface TripBill {
  id: string;
  date: string;
  title: string;
  amountCents: number;
  participants: readonly BillParticipant[];
  payers: readonly BillPayer[];
  validationCodes: readonly string[];
  createdAt: string;
  deletedAt: string | null;
}

export interface TripDetail {
  id: string;
  name: string;
  status: 'active' | 'completed';
  members: readonly TripMember[];
  dates: readonly string[];
  bills: readonly TripBill[];
  totalCents: number;
  invalidBillCount: number;
  version: number;
  ledgerRevision: number;
}

export interface SettlementTransfer {
  fromMemberId: string;
  toMemberId: string;
  amountCents: number;
}

export interface SettlementResponse {
  result: {
    transfers: readonly SettlementTransfer[];
    minimumTransferCount: number;
  };
  ignoredBillIds: readonly string[];
  ignoredCents: number;
  includedCents: number;
  ledgerRevision: number;
}

export interface TripActivity {
  id: string;
  tripId: string;
  actorUserId: string;
  action: string;
  entityType: 'trip' | 'date' | 'bill' | 'member';
  entityId: string;
  beforeVersion: number;
  afterVersion: number;
  createdAt: string;
}

export interface PublicUserProfile {
  userId: string;
  publicId: string;
  displayName: string;
  signature: string;
  avatarUrl: string | null;
}

export interface FriendView extends PublicUserProfile {
  friendshipId: string;
}

export interface BlockedUserView extends PublicUserProfile {
  blockId: string;
  blockedAt: string;
}

export interface AppNotification {
  id: string;
  type:
    | 'friend_request'
    | 'friend_accepted'
    | 'trip_invitation'
    | 'member_joined'
    | 'member_left'
    | 'trip_completed'
    | 'trip_reopened';
  actorUserId: string | null;
  tripId: string | null;
  requestId: string | null;
  invitationId: string | null;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

export interface CallApiOptions {
  requestId?: string;
  transportRetries?: number;
}

interface PendingWriteRequest {
  action: string;
  createdAt: number;
  ownerUserId: string;
  payload: string;
  requestId: string;
}

const PENDING_WRITES_KEY = 'pending-api-writes-v2';
const LEGACY_PENDING_WRITES_KEY = 'pending-api-writes-v1';
const SIGNED_OUT_KEY = 'local-session-signed-out-v1';
const PENDING_WRITE_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const READ_ACTIONS = new Set([
  'session.bootstrap',
  'social.search',
  'social.resolveQrScene',
  'social.listFriends',
  'social.listBlocked',
  'social.listNotifications',
  'trip.list',
  'trip.listArchived',
  'trip.get',
  'trip.activity',
  'trip.calculate',
]);

let pendingWrites: PendingWriteRequest[] | null = null;
let pendingWriteOwnerUserId: string | null = null;
let localApiGeneration = 0;
let localApiSignedOut = false;
const inFlightWrites = new Map<string, Promise<unknown>>();

export function callApi<T>(
  action: string,
  payload: unknown = {},
  options: CallApiOptions = {},
): Promise<T> {
  const writeAction = !READ_ACTIONS.has(action);
  const canonicalPayload = canonicalJson(payload);
  const apiGeneration = localApiGeneration;
  if (!writeAction) {
    if (action !== 'session.bootstrap' && isApiLocallySignedOut()) {
      return Promise.reject(
        new ApiError('LOCAL_SESSION_REQUIRED', '请从欢迎页重新进入后再操作。', false),
      );
    }
    const ownerUserId =
      action === 'session.bootstrap' ? undefined : (pendingWriteOwnerUserId ?? undefined);
    return performApiCall(
      action,
      payload,
      options,
      false,
      canonicalPayload,
      ownerUserId,
      apiGeneration,
    );
  }
  const ownerUserId = pendingWriteOwnerUserId;
  if (ownerUserId === null) {
    return Promise.reject(
      new ApiError('LOCAL_SESSION_REQUIRED', '请先完成微信身份登录后再操作。', true),
    );
  }

  const intentKey = `${ownerUserId}\n${action}\n${canonicalPayload}`;
  const active = inFlightWrites.get(intentKey);
  if (active !== undefined) return active as Promise<T>;
  const request = performApiCall<T>(
    action,
    payload,
    options,
    true,
    canonicalPayload,
    ownerUserId,
    apiGeneration,
  ).finally(() => {
    if (inFlightWrites.get(intentKey) === request) inFlightWrites.delete(intentKey);
  });
  inFlightWrites.set(intentKey, request);
  return request;
}

async function performApiCall<T>(
  action: string,
  payload: unknown,
  options: CallApiOptions,
  writeAction: boolean,
  canonicalPayload: string,
  ownerUserId?: string,
  apiGeneration?: number,
): Promise<T> {
  if (wx.cloud === undefined) throw new Error('当前微信版本不支持云开发。');
  const pending =
    writeAction && ownerUserId !== undefined
      ? findPendingWrite(ownerUserId, action, canonicalPayload)
      : null;
  if (pending !== null && Date.now() - pending.createdAt >= PENDING_WRITE_RETRY_WINDOW_MS) {
    throw new ApiError(
      'STALE_UNCERTAIN_WRITE',
      '本机仍有超过 23 小时未确认的相同操作。请先刷新并核对云端数据；确认未执行后，可退出登录再重新登录操作。',
      false,
      { requestId: pending.requestId },
    );
  }
  // An unresolved local intent always wins over a caller-supplied id: replacing it would
  // bypass the server's idempotency record and could apply the same mutation twice.
  const requestId = pending?.requestId ?? options.requestId ?? createRequestId();
  if (writeAction) {
    try {
      rememberPendingWrite({
        action,
        createdAt: pending?.requestId === requestId ? pending.createdAt : Date.now(),
        ownerUserId: ownerUserId!,
        payload: canonicalPayload,
        requestId,
      });
    } catch {
      throw new ApiError(
        'LOCAL_IDEMPOTENCY_STORAGE_FAILED',
        '本地存储空间不足，暂时无法安全提交。请清理微信存储空间后重试。',
        true,
      );
    }
  }
  const retries = options.transportRetries ?? 1;
  let result: Awaited<ReturnType<NonNullable<typeof wx.cloud>['callFunction']>>;
  for (let attempt = 0; ; attempt += 1) {
    try {
      result = await wx.cloud.callFunction({
        name: 'api',
        data: { action, payload, requestId },
      });
      break;
    } catch (error: unknown) {
      if (attempt < retries) continue;
      if (!writeAction) throw error;
      throw transportResultUncertain(requestId);
    }
  }
  const response = result.result;
  if (!isApiResponse<T>(response) || response.requestId !== requestId) {
    if (writeAction) throw transportResultUncertain(requestId);
    throw new Error('服务器返回了无法识别的数据。');
  }
  if (
    apiGeneration !== undefined &&
    (localApiGeneration !== apiGeneration ||
      (ownerUserId !== undefined && pendingWriteOwnerUserId !== ownerUserId))
  ) {
    throw new ApiError('LOCAL_SESSION_CHANGED', '登录状态已改变，请重新进入后核对结果。', true);
  }
  if (!response.ok) {
    if (
      writeAction &&
      response.error.code !== 'REQUEST_IN_PROGRESS' &&
      response.error.code !== 'REQUEST_RESULT_UNCERTAIN'
    ) {
      forgetPendingWrite(ownerUserId!, action, canonicalPayload);
    }
    throw new ApiError(
      response.error.code,
      response.error.message,
      response.error.retryable,
      response.error.details,
    );
  }
  if (writeAction) forgetPendingWrite(ownerUserId!, action, canonicalPayload);
  return response.data;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function createRequestId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${random}`;
}

function findPendingWrite(
  ownerUserId: string,
  action: string,
  payload: string,
): PendingWriteRequest | null {
  const records = loadPendingWrites();
  return (
    records.find(
      (record) =>
        record.ownerUserId === ownerUserId &&
        record.action === action &&
        record.payload === payload,
    ) ?? null
  );
}

function rememberPendingWrite(record: PendingWriteRequest): void {
  const records = loadPendingWrites().filter(
    (item) => !(item.action === record.action && item.payload === record.payload),
  );
  pendingWrites = [...records, record];
  persistPendingWrites(true);
}

function forgetPendingWrite(ownerUserId: string, action: string, payload: string): void {
  const records = loadPendingWrites();
  const next = records.filter(
    (record) =>
      !(
        record.ownerUserId === ownerUserId &&
        record.action === action &&
        record.payload === payload
      ),
  );
  if (next.length === records.length) return;
  pendingWrites = next;
  persistPendingWrites(false);
}

function transportResultUncertain(requestId: string): ApiError {
  return new ApiError(
    'TRANSPORT_RESULT_UNCERTAIN',
    '网络中断，操作结果暂时无法确认。请保持内容不变并再次点击，系统会核对同一请求；也可以刷新页面确认。',
    true,
    { requestId },
  );
}

function loadPendingWrites(): PendingWriteRequest[] {
  if (pendingWrites !== null) return pendingWrites;
  try {
    const stored = wx.getStorageSync<unknown>(PENDING_WRITES_KEY);
    pendingWrites = Array.isArray(stored)
      ? (stored as unknown[]).filter(isPendingWriteRequest)
      : [];
  } catch {
    pendingWrites = [];
  }
  return pendingWrites;
}

function isPendingWriteRequest(value: unknown): value is PendingWriteRequest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['action'] === 'string' &&
    typeof record['createdAt'] === 'number' &&
    typeof record['ownerUserId'] === 'string' &&
    typeof record['payload'] === 'string' &&
    typeof record['requestId'] === 'string'
  );
}

function isApiResponse<T>(value: unknown): value is ApiResponse<T> {
  if (typeof value !== 'object' || value === null || !('ok' in value)) return false;
  if (!('requestId' in value) || typeof value.requestId !== 'string') return false;
  if (value.ok === true) return 'data' in value;
  if (value.ok !== false || !('error' in value)) return false;
  const error = value.error;
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    'message' in error &&
    typeof error.message === 'string' &&
    'retryable' in error &&
    typeof error.retryable === 'boolean'
  );
}

function persistPendingWrites(throwOnFailure: boolean): void {
  try {
    if ((pendingWrites?.length ?? 0) === 0) wx.removeStorageSync(PENDING_WRITES_KEY);
    else wx.setStorageSync(PENDING_WRITES_KEY, pendingWrites);
  } catch (error: unknown) {
    if (throwOnFailure) throw error;
    // The in-memory record still protects retries during this app session.
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJsonValue(item)]),
  );
}

export function resetPendingWritesForTest(): void {
  pendingWrites = null;
  pendingWriteOwnerUserId = null;
  localApiGeneration = 0;
  localApiSignedOut = false;
  inFlightWrites.clear();
}

export function clearPendingApiWrites(): void {
  pendingWrites = [];
  pendingWriteOwnerUserId = null;
  localApiGeneration += 1;
  localApiSignedOut = true;
  inFlightWrites.clear();
  for (const key of [PENDING_WRITES_KEY, LEGACY_PENDING_WRITES_KEY]) {
    try {
      wx.removeStorageSync(key);
    } catch {
      // Best-effort local privacy cleanup during sign-out.
    }
  }
}

export function configureApiAccount(userId: string): void {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(userId)) {
    throw new ApiError('LOCAL_SESSION_INVALID', '本地账号标识无效，请重新进入小程序。', false);
  }
  if (pendingWriteOwnerUserId === userId) {
    localApiSignedOut = false;
    return;
  }
  if (pendingWriteOwnerUserId !== null) localApiGeneration += 1;
  pendingWriteOwnerUserId = userId;
  localApiSignedOut = false;
  inFlightWrites.clear();
  pendingWrites = null;
  pendingWrites = loadPendingWrites().filter((record) => record.ownerUserId === userId);
  persistPendingWrites(false);
  try {
    wx.removeStorageSync(LEGACY_PENDING_WRITES_KEY);
  } catch {
    // Legacy unscoped intents are never reused.
  }
}

function isApiLocallySignedOut(): boolean {
  if (localApiSignedOut) return true;
  try {
    return wx.getStorageSync<boolean>(SIGNED_OUT_KEY) === true;
  } catch {
    return true;
  }
}
