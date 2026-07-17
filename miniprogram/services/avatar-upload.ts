import { ApiError, createRequestId, type ApiResponse } from './api';

interface PendingAvatarStage {
  avatarToken: string;
  confirmed: boolean;
  createdAt: number;
  requestId: string;
  sha256: string;
  size: number;
}

const PENDING_AVATAR_STAGE_KEY = 'pending-avatar-stage-v1';
const MAX_AVATAR_BYTES = 1024 * 1024;
const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const CONFIRMED_REUSE_WINDOW_MS = 30 * 60 * 1000;

const DEFINITELY_REJECTED_CODES = new Set([
  'ACCOUNT_DELETION_PENDING',
  'AVATAR_CONTENT_MISMATCH',
  'AVATAR_METADATA_INVALID',
  'AVATAR_OWNERSHIP_INVALID',
  'AVATAR_SOURCE_INVALID',
  'AVATAR_STAGE_EXPIRED',
  'AVATAR_TOO_LARGE',
  'AVATAR_TOKEN_INVALID',
  'AVATAR_TYPE_INVALID',
  'AVATAR_URL_INVALID',
  'CONTENT_CHECK_UNAVAILABLE',
  'CONTENT_REJECTED',
  'PROFILE_VERSION_CONFLICT',
  'RATE_LIMITED',
  'REQUEST_INVALID',
  'SIGNATURE_INVALID',
  'USERNAME_INVALID',
]);

export async function stageAvatar(localPath: string): Promise<string> {
  if (wx.cloud === undefined || wx.cloud.CDN === undefined) {
    throw new Error('当前微信版本不支持安全头像上传，请升级微信后重试。');
  }
  const metadata = await fileMetadata(localPath);
  if (metadata.size < 1 || metadata.size > MAX_AVATAR_BYTES) {
    throw new ApiError('AVATAR_TOO_LARGE', '头像文件不能超过 1 MB。', false);
  }
  const stored = loadPendingStage();
  const storedAge = stored === null ? Number.POSITIVE_INFINITY : Date.now() - stored.createdAt;
  const reusable =
    stored !== null &&
    stored.size === metadata.size &&
    stored.sha256 === metadata.sha256 &&
    (!stored.confirmed || storedAge < CONFIRMED_REUSE_WINDOW_MS);
  const pending: PendingAvatarStage = reusable
    ? stored
    : {
        avatarToken: createRequestId(),
        confirmed: false,
        createdAt: Date.now(),
        requestId: createRequestId(),
        sha256: metadata.sha256,
        size: metadata.size,
      };
  if (pending.confirmed) return pending.avatarToken;
  if (Date.now() - pending.createdAt >= RETRY_WINDOW_MS) {
    clearPendingAvatarStage();
    throw new ApiError(
      'STALE_UNCERTAIN_AVATAR_STAGE',
      '这张头像的上传结果已无法安全确认，请重新选择图片。',
      false,
    );
  }
  persistPendingStage(pending);
  let result: Awaited<ReturnType<NonNullable<typeof wx.cloud>['callFunction']>>;
  try {
    result = await wx.cloud.callFunction({
      name: 'api',
      data: {
        action: 'session.stageAvatar',
        payload: {
          avatarToken: pending.avatarToken,
          sha256: pending.sha256,
          size: pending.size,
          sourceUrl: wx.cloud.CDN({ type: 'filePath', filePath: localPath }),
        },
        requestId: pending.requestId,
      },
    });
  } catch {
    throw uncertainAvatarStage(pending.requestId);
  }
  const response = result.result;
  if (
    !isApiResponse<{ avatarToken: string }>(response) ||
    response.requestId !== pending.requestId
  ) {
    throw uncertainAvatarStage(pending.requestId);
  }
  if (!response.ok) {
    if (!['REQUEST_IN_PROGRESS', 'REQUEST_RESULT_UNCERTAIN'].includes(response.error.code)) {
      clearPendingAvatarStage();
    }
    throw new ApiError(
      response.error.code,
      response.error.message,
      response.error.retryable,
      response.error.details,
    );
  }
  if (response.data.avatarToken !== pending.avatarToken) {
    throw uncertainAvatarStage(pending.requestId);
  }
  persistPendingStage({ ...pending, confirmed: true });
  return pending.avatarToken;
}

export function canDiscardUploadedAvatar(error: unknown): boolean {
  return error instanceof ApiError && DEFINITELY_REJECTED_CODES.has(error.code);
}

export function avatarSaveErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return '保存结果暂时无法确认，请重新进入资料页核对；为避免误删，刚上传的头像已保留。';
}

export function clearPendingAvatarStage(): void {
  try {
    wx.removeStorageSync(PENDING_AVATAR_STAGE_KEY);
  } catch {
    // Best-effort local privacy cleanup.
  }
}

export function resetAvatarStageForTest(): void {
  clearPendingAvatarStage();
}

function fileMetadata(localPath: string): Promise<{ sha256: string; size: number }> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().getFileInfo({
      digestAlgorithm: 'sha256',
      filePath: localPath,
      success: ({ digest, size }) => resolve({ sha256: digest.toLowerCase(), size }),
      fail: () => reject(new Error('无法读取头像文件，请重新选择。')),
    });
  });
}

function loadPendingStage(): PendingAvatarStage | null {
  try {
    const value = wx.getStorageSync<unknown>(PENDING_AVATAR_STAGE_KEY);
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record['avatarToken'] !== 'string' ||
      typeof record['confirmed'] !== 'boolean' ||
      typeof record['createdAt'] !== 'number' ||
      typeof record['requestId'] !== 'string' ||
      typeof record['sha256'] !== 'string' ||
      typeof record['size'] !== 'number'
    ) {
      return null;
    }
    return record as unknown as PendingAvatarStage;
  } catch {
    return null;
  }
}

function persistPendingStage(stage: PendingAvatarStage): void {
  try {
    wx.setStorageSync(PENDING_AVATAR_STAGE_KEY, stage);
  } catch {
    throw new ApiError(
      'LOCAL_IDEMPOTENCY_STORAGE_FAILED',
      '本地存储空间不足，暂时无法安全上传头像。',
      true,
    );
  }
}

function uncertainAvatarStage(requestId: string): ApiError {
  return new ApiError(
    'TRANSPORT_RESULT_UNCERTAIN',
    '网络中断，头像上传结果暂时无法确认。请保持同一张图片并再次保存。',
    true,
    { requestId },
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
