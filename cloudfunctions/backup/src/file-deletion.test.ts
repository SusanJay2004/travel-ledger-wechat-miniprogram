import { describe, expect, it, vi } from 'vitest';

import { deleteFilesCompletely } from './file-deletion';

describe('backup file deletion', () => {
  it('deletes at most 50 files per platform call', async () => {
    const deleteFile = vi.fn(async ({ fileList }: { fileList: string[] }) => ({
      fileList: fileList.map((fileID) => ({ fileID, status: 0 })),
    }));
    const fileIds = Array.from({ length: 121 }, (_, index) => `cloud://backup/${index}`);

    await deleteFilesCompletely({ deleteFile }, fileIds);

    expect(deleteFile).toHaveBeenCalledTimes(3);
    expect(deleteFile.mock.calls.map(([options]) => options.fileList.length)).toEqual([50, 50, 21]);
  });

  it('fails closed when a file is missing from the response or reports an error', async () => {
    await expect(
      deleteFilesCompletely(
        {
          deleteFile: async () => ({
            fileList: [
              { fileID: 'cloud://backup/first', status: 0 },
              { fileID: 'cloud://backup/second', status: -1 },
            ],
          }),
        },
        ['cloud://backup/first', 'cloud://backup/second', 'cloud://backup/missing'],
      ),
    ).rejects.toMatchObject({ code: 'FILE_DELETE_INCOMPLETE', failedCount: 2 });
  });

  it('treats an already absent file as an idempotent success', async () => {
    await expect(
      deleteFilesCompletely(
        {
          deleteFile: async ({ fileList }) => ({
            fileList: fileList.map((fileID) => ({ fileID, status: -503003 })),
          }),
        },
        ['cloud://backup/already-removed'],
      ),
    ).resolves.toBeUndefined();
  });
});
