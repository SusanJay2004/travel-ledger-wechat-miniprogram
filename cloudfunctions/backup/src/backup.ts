export const BACKUP_COLLECTIONS = [
  'users',
  'trips',
  'friend_requests',
  'friendships',
  'blocks',
  'notifications',
  'trip_invitations',
  'audit_logs',
] as const;

export function backupPrefix(now: Date, backupId: string): string {
  const day = now.toISOString().slice(0, 10);
  return `private-backups/${day}/${backupId}`;
}

export function pagePath(prefix: string, collection: string, page: number): string {
  return `${prefix}/${collection}/${String(page).padStart(5, '0')}.json.gz`;
}

export function expiresAt(now: Date, retentionDays = 30): string {
  return new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000).toISOString();
}
