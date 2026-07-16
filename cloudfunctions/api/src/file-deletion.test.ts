import { describe, expect, it } from 'vitest';

import { deleteFilesCompletely } from './file-deletion';

describe('account file deletion', () => {
  it('requires every requested file to be deleted or already absent', async () => {
    await expect(
      deleteFilesCompletely(
        {
          deleteFile: async ({ fileList }) => ({
            fileList: fileList.map((fileID, index) => ({
              fileID,
              status: index === 0 ? 0 : -503003,
            })),
          }),
        },
        ['cloud://avatar', 'cloud://code'],
      ),
    ).resolves.toBeUndefined();

    await expect(
      deleteFilesCompletely(
        {
          deleteFile: async ({ fileList }) => ({
            fileList: fileList.map((fileID) => ({ fileID, status: -503001 })),
          }),
        },
        ['cloud://avatar'],
      ),
    ).rejects.toThrow('cloud file deletion was incomplete');
  });
});
