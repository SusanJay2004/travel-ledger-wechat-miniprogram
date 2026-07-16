export function successResponse<T>(requestId: string, data: T) {
  return { ok: true as const, requestId, data: sanitizeClientData(data) };
}

export function sanitizeClientData<T>(value: T): T {
  if (Array.isArray(value)) {
    const items: unknown[] = value.map((item: unknown) => sanitizeClientData(item));
    return items as T;
  }
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (CLIENT_PRIVATE_KEYS.has(key)) continue;
    copy[key] = sanitizeClientData(item);
  }
  return copy as T;
}

const CLIENT_PRIVATE_KEYS = new Set([
  'openId',
  'ownerOpenId',
  'pendingFileDeletionIds',
  'projectionOutbox',
  'qrCodeFileId',
  'qrSceneToken',
  'settlementCache',
]);
