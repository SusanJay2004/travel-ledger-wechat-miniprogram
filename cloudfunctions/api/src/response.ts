export function successResponse<T>(requestId: string, data: T) {
  return { ok: true as const, requestId, data: sanitizeClientData(data) };
}

export function failureResponse(
  requestId: string,
  code: string,
  message: string,
  retryable = false,
  details?: Readonly<Record<string, unknown>>,
) {
  return {
    ok: false as const,
    requestId,
    error: {
      code,
      message,
      retryable,
      ...(details === undefined ? {} : { details: sanitizeClientData(details) }),
    },
  };
}

export function sanitizeClientData<T>(value: T): T {
  return sanitizeValue(value) as T;
}

function sanitizeValue(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => sanitizeValue(item, parentKey));
  }
  if (
    typeof value === 'string' &&
    value.startsWith('cloud://') &&
    CLIENT_FILE_KEYS.has(parentKey ?? '')
  ) {
    return null;
  }
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (CLIENT_PRIVATE_KEYS.has(key)) continue;
    copy[key] = sanitizeValue(item, key);
  }
  return copy;
}

const CLIENT_FILE_KEYS = new Set(['avatarUrl', 'fileId']);

const CLIENT_PRIVATE_KEYS = new Set([
  '_id',
  'openId',
  'ownerOpenId',
  'pendingAvatarExpiresAt',
  'pendingAvatarFileId',
  'pendingAvatarReviewId',
  'pendingFileDeletionIds',
  'stagedAvatarFileId',
  'stagedAvatarToken',
  'stagedAvatarExpiresAt',
  'stagedAvatarSha256',
  'stagedAvatarSize',
  'projectionOutbox',
  'pendingKey',
  'qrCodeFileId',
  'qrSceneToken',
  'settlementCache',
]);
