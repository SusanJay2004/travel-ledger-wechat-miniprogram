import { BusinessError } from './errors';

export interface ContentSecurity {
  checkText(openId: string, scene: number, ...values: string[]): Promise<void>;
  startImageReview(openId: string, fileId: string): Promise<ImageReviewSubmission>;
}

export type ImageReviewSubmission = { status: 'pass' } | { status: 'pending'; traceId: string };

interface SecurityCloud {
  downloadFile(options: { fileID: string }): Promise<{ fileContent: Buffer }>;
  getTempFileURL(options: { fileList: string[] }): Promise<{
    fileList: readonly { fileID: string; tempFileURL: string; status: number }[];
  }>;
  openapi: {
    security: {
      mediaCheckAsync(options: {
        mediaUrl: string;
        mediaType: number;
        openid: string;
        scene: number;
        version: number;
      }): Promise<{ traceId?: string }>;
      msgSecCheck(options: {
        content: string;
        openid: string;
        scene: number;
        version: number;
      }): Promise<{ result?: { suggest?: string; label?: number } }>;
    };
  };
}

export class WechatContentSecurity implements ContentSecurity {
  constructor(
    private readonly cloud: SecurityCloud,
    private readonly enabled: boolean,
  ) {}

  async checkText(openId: string, scene: number, ...values: string[]): Promise<void> {
    if (!this.enabled) return;
    const content = values
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .join('\n');
    if (content.length === 0) return;
    try {
      const result = await this.cloud.openapi.security.msgSecCheck({
        content,
        openid: openId,
        scene,
        version: 2,
      });
      if (result.result?.suggest !== 'pass') {
        throw new BusinessError(
          'CONTENT_REJECTED',
          '内容可能不符合平台规范，请修改后重试。',
          false,
          { label: result.result?.label ?? 0 },
        );
      }
    } catch (error: unknown) {
      if (error instanceof BusinessError) throw error;
      console.error('text-security-check-failed', { scene, error: errorCode(error) });
      throw new BusinessError(
        'CONTENT_CHECK_UNAVAILABLE',
        '内容审核服务暂时不可用，请稍后重试。',
        true,
      );
    }
  }

  async startImageReview(openId: string, fileId: string): Promise<ImageReviewSubmission> {
    if (!this.enabled) return { status: 'pass' };
    if (!fileId.startsWith('cloud://')) {
      throw new BusinessError('AVATAR_URL_INVALID', '头像必须来自本小程序云存储。');
    }
    try {
      const downloaded = await this.cloud.downloadFile({ fileID: fileId });
      if (downloaded.fileContent.byteLength > 1024 * 1024) {
        throw new BusinessError('AVATAR_TOO_LARGE', '头像文件不能超过 1 MB。');
      }
      detectSupportedImageType(downloaded.fileContent);
      const urls = await this.cloud.getTempFileURL({ fileList: [fileId] });
      const temporary = urls.fileList.find((item) => item.fileID === fileId);
      if (temporary?.status !== 0 || !temporary.tempFileURL.startsWith('https://')) {
        throw new BusinessError(
          'AVATAR_URL_UNAVAILABLE',
          '暂时无法提交头像审核，请稍后重试。',
          true,
        );
      }
      const result = await this.cloud.openapi.security.mediaCheckAsync({
        mediaUrl: temporary.tempFileURL,
        mediaType: 2,
        openid: openId,
        scene: 1,
        version: 2,
      });
      if (typeof result.traceId !== 'string' || result.traceId.length === 0) {
        throw new BusinessError(
          'CONTENT_CHECK_UNAVAILABLE',
          '头像审核服务暂时不可用，请稍后重试。',
          true,
        );
      }
      return { status: 'pending', traceId: result.traceId };
    } catch (error: unknown) {
      if (error instanceof BusinessError) throw error;
      const code = errorCode(error);
      console.error('image-security-check-failed', { code });
      throw new BusinessError(
        'CONTENT_CHECK_UNAVAILABLE',
        '头像审核服务暂时不可用，请稍后重试。',
        true,
      );
    }
  }
}

const noop: ContentSecurity = {
  checkText: async () => undefined,
  startImageReview: async () => ({ status: 'pass' }),
};

export function disabledContentSecurity(): ContentSecurity {
  return noop;
}

export function detectSupportedImageType(buffer: Buffer): 'image/jpeg' | 'image/png' {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  throw new BusinessError('AVATAR_TYPE_INVALID', '头像仅支持 JPG 或 PNG。');
}

function errorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'unknown';
  if ('errCode' in error) return String(error.errCode);
  if ('code' in error) return String(error.code);
  return 'unknown';
}
