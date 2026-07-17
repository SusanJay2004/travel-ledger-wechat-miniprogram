const BILL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function isDeletedBillRestorable(deletedAt: string | null, now = Date.now()): boolean {
  if (deletedAt === null) return false;
  const deletedTime = new Date(deletedAt).getTime();
  return (
    Number.isFinite(deletedTime) && now - deletedTime >= 0 && now - deletedTime < BILL_RETENTION_MS
  );
}
