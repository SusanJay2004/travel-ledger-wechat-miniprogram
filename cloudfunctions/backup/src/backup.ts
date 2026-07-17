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

const CHINA_STANDARD_TIME_OFFSET_MS = 8 * 60 * 60 * 1000;

export function backupDay(now: Date): string {
  return new Date(now.getTime() + CHINA_STANDARD_TIME_OFFSET_MS).toISOString().slice(0, 10);
}

export function backupIdForDay(day: string): string {
  return `bak_${day.replaceAll('-', '')}`;
}

export function backupPrefix(day: string, backupId: string, attemptId: string): string {
  return `private-backups/${day}/${backupId}/attempt_${attemptId}`;
}

export function pagePath(prefix: string, collection: string, page: number): string {
  return `${prefix}/${collection}/${String(page).padStart(5, '0')}.json.gz`;
}

export function expiresAt(now: Date, retentionDays = 30): string {
  return new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000).toISOString();
}

export interface BackupManifestState {
  collections: Readonly<Record<string, { documents: number; pages: number }>>;
  fileIds: readonly string[];
}

export function appendBackupProgress(
  state: BackupManifestState,
  collectionName: string,
  fileIds: readonly string[],
  summary: { documents: number; pages: number },
): BackupManifestState {
  return {
    collections: { ...state.collections, [collectionName]: summary },
    fileIds: [...state.fileIds, ...fileIds],
  };
}
