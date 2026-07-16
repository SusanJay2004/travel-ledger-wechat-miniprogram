export interface DeleteFileResultItem {
  fileID: string;
  status: number;
}

export interface FileDeletionCloud {
  deleteFile(options: { fileList: string[] }): Promise<{
    fileList: readonly DeleteFileResultItem[];
  }>;
}

const DELETE_BATCH_SIZE = 50;
const FILE_NOT_FOUND_STATUS = -503003;

export async function deleteFilesCompletely(
  cloud: FileDeletionCloud,
  fileIds: readonly string[],
): Promise<void> {
  for (let offset = 0; offset < fileIds.length; offset += DELETE_BATCH_SIZE) {
    const batch = fileIds.slice(offset, offset + DELETE_BATCH_SIZE);
    const response = await cloud.deleteFile({ fileList: [...batch] });
    const statuses = new Map(response.fileList.map((item) => [item.fileID, item.status]));
    const failed = batch.filter((fileId) => {
      const status = statuses.get(fileId);
      return status !== 0 && status !== FILE_NOT_FOUND_STATUS;
    });
    if (failed.length > 0) throw new Error('cloud file deletion was incomplete');
  }
}
