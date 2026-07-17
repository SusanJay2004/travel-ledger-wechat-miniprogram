import { describe, expect, it, vi } from 'vitest';

import { WechatContentSecurity } from './content-security';

function createCloud(options: { suggest?: string; mediaError?: unknown; traceId?: string } = {}) {
  const msgSecCheck = vi.fn(async () => ({
    result: {
      suggest: options.suggest ?? 'pass',
      label: options.suggest === 'risky' ? 20001 : 100,
    },
  }));
  return {
    cloud: {
      downloadFile: async () => ({ fileContent: Buffer.from([0xff, 0xd8, 0xff, 0x00]) }),
      getTempFileURL: async ({ fileList }: { fileList: string[] }) => ({
        fileList: fileList.map((fileID) => ({
          fileID,
          status: 0,
          tempFileURL: 'https://example.test/avatar.jpg',
        })),
      }),
      openapi: {
        security: {
          mediaCheckAsync: async () => {
            if (options.mediaError !== undefined) {
              throw options.mediaError instanceof Error
                ? options.mediaError
                : new Error('media check failed');
            }
            return { traceId: options.traceId ?? 'trace-123456' };
          },
          msgSecCheck,
        },
      },
    },
    msgSecCheck,
  };
}

describe('WechatContentSecurity', () => {
  it('accepts text only when the platform suggests pass', async () => {
    const passing = createCloud();
    await expect(
      new WechatContentSecurity(passing.cloud, true).checkText('openid', 3, '海边晚餐'),
    ).resolves.toBeUndefined();
    expect(passing.msgSecCheck).toHaveBeenCalledWith({
      content: '海边晚餐',
      openid: 'openid',
      scene: 3,
      version: 2,
    });
    const rejected = createCloud({ suggest: 'risky' });
    await expect(
      new WechatContentSecurity(rejected.cloud, true).checkText('openid', 3, '不当内容'),
    ).rejects.toMatchObject({ code: 'CONTENT_REJECTED' });
  });

  it('submits a supported cloud image to the asynchronous 2.0 profile scene', async () => {
    const setup = createCloud();
    const mediaCheckAsync = vi.spyOn(setup.cloud.openapi.security, 'mediaCheckAsync');
    const security = new WechatContentSecurity(setup.cloud, true);
    await expect(
      security.startImageReview('openid', 'https://example.com/avatar.jpg'),
    ).rejects.toMatchObject({ code: 'AVATAR_URL_INVALID' });
    await expect(security.startImageReview('openid', 'cloud://avatar.jpg')).resolves.toEqual({
      status: 'pending',
      traceId: 'trace-123456',
    });
    expect(mediaCheckAsync).toHaveBeenCalledWith({
      mediaUrl: 'https://example.test/avatar.jpg',
      mediaType: 2,
      openid: 'openid',
      scene: 1,
      version: 2,
    });
  });

  it('can be explicitly disabled for local development', async () => {
    const security = new WechatContentSecurity(createCloud({ suggest: 'risky' }).cloud, false);
    await expect(security.checkText('openid', 3, 'anything')).resolves.toBeUndefined();
    await expect(security.startImageReview('openid', 'local-path')).resolves.toEqual({
      status: 'pass',
    });
  });
});
