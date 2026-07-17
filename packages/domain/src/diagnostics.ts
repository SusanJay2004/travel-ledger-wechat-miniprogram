const SAFE_DIAGNOSTIC_CODE = /^(?:-?\d{1,12}|[A-Z][A-Z0-9._:-]{0,63})$/;

export function safeDiagnosticCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'unknown';
  const record = error as Readonly<Record<string, unknown>>;
  for (const key of ['errCode', 'code'] as const) {
    const value = record[key];
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const normalized = String(value);
    if (SAFE_DIAGNOSTIC_CODE.test(normalized)) return normalized;
  }
  return 'unknown';
}

export function redactedRuntimeError(error: unknown, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: safeDiagnosticCode(error) });
}
