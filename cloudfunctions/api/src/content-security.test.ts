import { describe, expect, it, vi } from 'vitest';

import { WechatContentSecurity } from './content-security';

function createCloud(options: { suggest?: string; imageError?: unknown } = {}) {
  const msgSecCheck = vi.fn(async () => ({
    result: {
      suggest: options.suggest ?? 'pass',
      label: options.suggest === 'risky' ? 20001 : 100,
    },
  }));
  return {
    cloud: {
      downloadFile: async () => ({ fileContent: Buffer.from([0xff, 0xd8, 0xff, 0x00]) }),
      openapi: {
        security: {
          imgSecCheck: async () => {
            if (options.imageError !== undefined) {
              const error = new Error('image rejected') as Error & { errCode?: number };
              if (
                typeof options.imageError === 'object' &&
                options.imageError !== null &&
                'errCode' in options.imageError
              ) {
                error.errCode = Number(options.imageError.errCode);
              }
              throw error;
            }
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

  it('requires a supported cloud image and maps risky image errors', async () => {
    const security = new WechatContentSecurity(createCloud().cloud, true);
    await expect(
      security.checkImage('openid', 'https://example.com/avatar.jpg'),
    ).rejects.toMatchObject({ code: 'AVATAR_URL_INVALID' });
    await expect(security.checkImage('openid', 'cloud://avatar.jpg')).resolves.toBeUndefined();
    await expect(
      new WechatContentSecurity(
        createCloud({ imageError: { errCode: 87014 } }).cloud,
        true,
      ).checkImage('openid', 'cloud://avatar.jpg'),
    ).rejects.toMatchObject({ code: 'CONTENT_REJECTED' });
  });

  it('can be explicitly disabled for local development', async () => {
    const security = new WechatContentSecurity(createCloud({ suggest: 'risky' }).cloud, false);
    await expect(security.checkText('openid', 3, 'anything')).resolves.toBeUndefined();
    await expect(security.checkImage('openid', 'local-path')).resolves.toBeUndefined();
  });
});
