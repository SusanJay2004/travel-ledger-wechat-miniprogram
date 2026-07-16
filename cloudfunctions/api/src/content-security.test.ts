import { describe, expect, it } from 'vitest';

import { WechatContentSecurity } from './content-security';

function createCloud(options: { suggest?: string; imageError?: unknown } = {}) {
  return {
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
        msgSecCheck: async () => ({
          result: {
            suggest: options.suggest ?? 'pass',
            label: options.suggest === 'risky' ? 20001 : 100,
          },
        }),
      },
    },
  };
}

describe('WechatContentSecurity', () => {
  it('accepts text only when the platform suggests pass', async () => {
    await expect(
      new WechatContentSecurity(createCloud(), true).checkText('openid', 3, '海边晚餐'),
    ).resolves.toBeUndefined();
    await expect(
      new WechatContentSecurity(createCloud({ suggest: 'risky' }), true).checkText(
        'openid',
        3,
        '不当内容',
      ),
    ).rejects.toMatchObject({ code: 'CONTENT_REJECTED' });
  });

  it('requires a supported cloud image and maps risky image errors', async () => {
    const security = new WechatContentSecurity(createCloud(), true);
    await expect(
      security.checkImage('openid', 'https://example.com/avatar.jpg'),
    ).rejects.toMatchObject({ code: 'AVATAR_URL_INVALID' });
    await expect(security.checkImage('openid', 'cloud://avatar.jpg')).resolves.toBeUndefined();
    await expect(
      new WechatContentSecurity(createCloud({ imageError: { errCode: 87014 } }), true).checkImage(
        'openid',
        'cloud://avatar.jpg',
      ),
    ).rejects.toMatchObject({ code: 'CONTENT_REJECTED' });
  });

  it('can be explicitly disabled for local development', async () => {
    const security = new WechatContentSecurity(createCloud({ suggest: 'risky' }), false);
    await expect(security.checkText('openid', 3, 'anything')).resolves.toBeUndefined();
    await expect(security.checkImage('openid', 'local-path')).resolves.toBeUndefined();
  });
});
