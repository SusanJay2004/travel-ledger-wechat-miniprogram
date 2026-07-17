import { describe, expect, it, vi } from 'vitest';

import { attachTemporaryAvatarUrls, temporaryDisplayUrl } from './file-access';

describe('authorized cloud file display URLs', () => {
  it('returns only matching successful HTTPS temporary URLs', async () => {
    const getTempFileURL = vi.fn(async () => ({
      fileList: [
        { fileID: 'cloud://env/code.png', status: 0, tempFileURL: 'https://temp.test/code.png' },
      ],
    }));

    await expect(temporaryDisplayUrl({ getTempFileURL }, 'cloud://env/code.png')).resolves.toBe(
      'https://temp.test/code.png',
    );
    expect(getTempFileURL).toHaveBeenCalledWith({
      fileList: [{ fileID: 'cloud://env/code.png', maxAge: 3600 }],
    });
  });

  it('fails closed for non-cloud, mismatched, failed, or insecure URLs', async () => {
    const getTempFileURL = vi.fn(async () => ({
      fileList: [
        { fileID: 'cloud://env/other.png', status: 0, tempFileURL: 'http://temp.test/other.png' },
      ],
    }));

    await expect(
      temporaryDisplayUrl({ getTempFileURL }, 'https://foreign.test/a.png'),
    ).resolves.toBeNull();
    await expect(
      temporaryDisplayUrl({ getTempFileURL }, 'cloud://env/code.png'),
    ).resolves.toBeNull();
  });

  it('deduplicates and batches authorized avatar URL signing', async () => {
    const getTempFileURL = vi.fn(
      async ({ fileList }: { fileList: (string | { fileID: string; maxAge?: number })[] }) => ({
        fileList: fileList.map((entry) => {
          const fileID = typeof entry === 'string' ? entry : entry.fileID;
          return {
            fileID,
            status: 0,
            tempFileURL: `https://temp.test/${encodeURIComponent(fileID)}`,
          };
        }),
      }),
    );
    const profiles = Array.from({ length: 52 }, (_, index) => ({
      userId: `user-${index}`,
      avatarUrl: index === 51 ? 'cloud://env/avatar-0.png' : `cloud://env/avatar-${index}.png`,
    }));

    const displayed = await attachTemporaryAvatarUrls({ getTempFileURL }, profiles);

    expect(getTempFileURL).toHaveBeenCalledTimes(2);
    expect(displayed[0]?.avatarUrl).toContain('https://temp.test/');
    expect(displayed[51]?.avatarUrl).toBe(displayed[0]?.avatarUrl);
  });

  it('does not pass through corrupted external avatar records', async () => {
    const getTempFileURL = vi.fn();
    await expect(
      attachTemporaryAvatarUrls({ getTempFileURL }, [
        { userId: 'user-1', avatarUrl: 'https://untrusted.test/avatar.jpg' },
      ]),
    ).resolves.toEqual([{ userId: 'user-1', avatarUrl: null }]);
    expect(getTempFileURL).not.toHaveBeenCalled();
  });
});
