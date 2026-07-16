interface ApiEvent {
  action?: unknown;
  payload?: unknown;
  requestId?: unknown;
}

interface CloudContext {
  OPENID?: string;
}

interface CloudSdk {
  DYNAMIC_CURRENT_ENV: symbol;
  getWXContext(): CloudContext;
  init(options: { env: symbol }): void;
}

// wx-server-sdk is installed by the cloud function workspace and intentionally loaded at runtime.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cloud = require('wx-server-sdk') as CloudSdk;
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

export async function main(event: ApiEvent): Promise<unknown> {
  const requestId = typeof event.requestId === 'string' ? event.requestId : 'missing-request-id';
  const action = typeof event.action === 'string' ? event.action : '';
  const openId = cloud.getWXContext().OPENID;

  if (openId === undefined || openId.length === 0) {
    return failure(requestId, 'UNAUTHENTICATED', '无法识别当前微信用户，请重新进入小程序。', false);
  }

  switch (action) {
    case 'trip.list':
      return success(requestId, []);
    case 'session.bootstrap':
      return success(requestId, {
        userId: 'development-user',
        publicId: 'DEV2345678',
        displayName: '旅人234567',
        signature: '这个人很懒，什么也没留下～',
        avatarUrl: null,
      });
    case 'trip.create':
      return failure(requestId, 'NOT_IMPLEMENTED', '行程持久化正在建设，请稍后再试。', false);
    default:
      return failure(requestId, 'UNKNOWN_ACTION', '无法识别该操作。', false);
  }
}

function success<T>(requestId: string, data: T) {
  return { ok: true as const, requestId, data };
}

function failure(requestId: string, code: string, message: string, retryable: boolean) {
  return { ok: false as const, requestId, error: { code, message, retryable } };
}
