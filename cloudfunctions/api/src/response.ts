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
  if (
    !Array.isArray(record['members']) ||
    !Array.isArray(record['bills']) ||
    !Array.isArray(record['dates']) ||
    typeof record['ledgerRevision'] !== 'number'
  ) {
    return value;
  }
  const copy = { ...record };
  delete copy['projectionOutbox'];
  delete copy['settlementCache'];
  return copy as T;
}
