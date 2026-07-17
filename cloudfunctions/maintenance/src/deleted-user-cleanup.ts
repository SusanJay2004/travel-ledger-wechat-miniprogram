export interface DeletedUserFileRecord {
  avatarUrl?: string | null;
  id: string;
  pendingAvatarFileId?: string | null;
  pendingFileDeletionIds?: readonly string[];
  qrCodeFileId?: string | null;
  stagedAvatarFileId?: string | null;
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
    const markedFiles = user.pendingFileDeletionIds ?? [];
    if (markedFiles.length === 0) continue;
    const fileList = deletableFiles(user);
    try {
      if (fileList.length > 0) await dependencies.deleteFiles(fileList);
      if (await dependencies.clearMarker(user, now.toISOString())) removed += fileList.length;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { failed, removed };
}

function deletableFiles(user: DeletedUserFileRecord): readonly string[] {
  const referenced = new Set(
    [user.avatarUrl, user.pendingAvatarFileId, user.stagedAvatarFileId, user.qrCodeFileId].filter(
      (value): value is string => typeof value === 'string' && value.startsWith('cloud://'),
    ),
  );
  return [...new Set(user.pendingFileDeletionIds ?? [])].filter(
    (fileId) => fileId.startsWith('cloud://') && !referenced.has(fileId),
  );
}
