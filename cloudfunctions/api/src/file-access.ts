export interface TemporaryFileUrlCloud {
  getTempFileURL(options: { fileList: (string | { fileID: string; maxAge?: number })[] }): Promise<{
    fileList: readonly {
      fileID: string;
      tempFileURL: string;
      status: number;
    }[];
  }>;
}

const DISPLAY_URL_MAX_AGE_SECONDS = 60 * 60;

export async function temporaryDisplayUrl(
  cloud: TemporaryFileUrlCloud,
  fileId: string | null | undefined,
): Promise<string | null> {
  if (fileId === null || fileId === undefined) return null;
  if (!fileId.startsWith('cloud://')) return null;
  try {
    const result = await cloud.getTempFileURL({
      fileList: [{ fileID: fileId, maxAge: DISPLAY_URL_MAX_AGE_SECONDS }],
    });
    const item = result.fileList.find((candidate) => candidate.fileID === fileId);
    if (item?.status !== 0 || !isHttpsUrl(item.tempFileURL)) return null;
    return item.tempFileURL;
  } catch {
    return null;
  }
}

export async function attachTemporaryAvatarUrls<T extends { avatarUrl: string | null }>(
  cloud: TemporaryFileUrlCloud,
  profiles: readonly T[],
): Promise<readonly T[]> {
  const uniqueFileIds = [
    ...new Set(
      profiles.flatMap((profile) =>
        profile.avatarUrl?.startsWith('cloud://') === true ? [profile.avatarUrl] : [],
      ),
    ),
  ];
  const urls = new Map<string, string>();
  for (let offset = 0; offset < uniqueFileIds.length; offset += 50) {
    const batch = uniqueFileIds.slice(offset, offset + 50);
    try {
      const result = await cloud.getTempFileURL({
        fileList: batch.map((fileID) => ({ fileID, maxAge: DISPLAY_URL_MAX_AGE_SECONDS })),
      });
      for (const item of result.fileList) {
        if (item.status === 0 && isHttpsUrl(item.tempFileURL))
          urls.set(item.fileID, item.tempFileURL);
      }
    } catch {
      // A missing display URL must not expose a cloud file ID or fail the whole social list.
    }
  }
  return profiles.map((profile) => ({
    ...profile,
    avatarUrl: profile.avatarUrl === null ? null : (urls.get(profile.avatarUrl) ?? null),
  }));
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
