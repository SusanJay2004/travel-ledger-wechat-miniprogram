export interface DeletedUserFileRecord {
  id: string;
  pendingFileDeletionIds?: readonly string[];
  version: number;
}

export interface DeletedUserFileCleanupDependencies {
  clearMarker(user: DeletedUserFileRecord, updatedAt: string): Promise<boolean>;
  deleteFiles(fileIds: readonly string[]): Promise<void>;
}

export interface DeletedUserFileCleanupSummary {
  failed: number;
  removed: number;
}

export async function cleanDeletedUserFiles(
  users: readonly DeletedUserFileRecord[],
  dependencies: DeletedUserFileCleanupDependencies,
  now: Date,
): Promise<DeletedUserFileCleanupSummary> {
  let failed = 0;
  let removed = 0;
  for (const user of users) {
    const fileList = user.pendingFileDeletionIds ?? [];
    if (fileList.length === 0) continue;
    try {
      await dependencies.deleteFiles(fileList);
      if (await dependencies.clearMarker(user, now.toISOString())) removed += fileList.length;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { failed, removed };
}
