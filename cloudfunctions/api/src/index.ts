import { CloudRepository, type CloudDatabase } from './cloud-repository';
import { CloudSocialRepository } from './cloud-social-repository';
import { WechatContentSecurity } from './content-security';
import { BusinessError } from './errors';
import { EventPublisher } from './event-publisher';
import { secureIdGenerator, systemClock } from './generators';
import { IdempotencyService, isWriteAction } from './idempotency';
import { LedgerService } from './service';
import { RateLimiter } from './rate-limit';
import { SocialService } from './social-service';

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
  database(): CloudDatabase;
  deleteFile(options: { fileList: string[] }): Promise<unknown>;
  getWXContext(): CloudContext;
  init(options: { env: symbol }): void;
  openapi: {
    security: {
      imgSecCheck(options: { media: { contentType: string; value: Buffer } }): Promise<unknown>;
      msgSecCheck(options: {
        content: string;
        openid: string;
        scene: number;
        version: number;
      }): Promise<{ result?: { suggest?: string; label?: number } }>;
    };
    wxacode: {
      getUnlimited(options: {
        scene: string;
        page: string;
        checkPath: boolean;
        envVersion: 'develop' | 'trial' | 'release';
      }): Promise<{ buffer?: Buffer }>;
    };
  };
  downloadFile(options: { fileID: string }): Promise<{ fileContent: Buffer }>;
  uploadFile(options: { cloudPath: string; fileContent: Buffer }): Promise<{ fileID: string }>;
}

// wx-server-sdk is installed by the cloud function workspace and loaded by the cloud runtime.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cloud = require('wx-server-sdk') as CloudSdk;
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

export async function main(event: ApiEvent): Promise<unknown> {
  const requestId = typeof event.requestId === 'string' ? event.requestId : 'missing-request-id';
  const action = typeof event.action === 'string' ? event.action : '';
  const openId = cloud.getWXContext().OPENID;

  if (openId === undefined || openId.length === 0) {
    return failure(requestId, 'UNAUTHENTICATED', '无法识别当前微信用户，请重新进入小程序。');
  }
  if (!/^[A-Za-z0-9-]{8,80}$/.test(requestId)) {
    return failure(requestId, 'REQUEST_ID_INVALID', '请求标识格式不正确。');
  }

  const database = cloud.database();
  const repository = new CloudRepository(database);
  const socialRepository = new CloudSocialRepository(database);
  const publisher = new EventPublisher(socialRepository, repository);
  const idempotency = new IdempotencyService(database, systemClock);
  const rateLimiter = new RateLimiter(database, systemClock);
  const contentSecurity = new WechatContentSecurity(
    cloud,
    process.env['CONTENT_SECURITY_MODE'] !== 'disabled',
  );
  const service = new LedgerService(
    repository,
    systemClock,
    secureIdGenerator,
    publisher,
    contentSecurity,
  );
  const productMode = process.env['PRODUCT_MODE'] === 'collaboration' ? 'collaboration' : 'solo';
  const social = new SocialService(
    repository,
    socialRepository,
    systemClock,
    secureIdGenerator,
    productMode,
    publisher,
  );

  try {
    await rateLimiter.consume(openId, requestId, action);
    const existingUser = await repository.findUserByOpenId(openId);
    if (action === 'session.deleteAccount' && existingUser === null) {
      await idempotency.execute(openId, requestId, action, async () => null);
      return success(requestId, null);
    }
    const user =
      action === 'session.deleteAccount' && existingUser?.status === 'deleting'
        ? existingUser
        : await service.bootstrapSession(openId);
    const write = <T>(operation: () => Promise<T>) =>
      isWriteAction(action)
        ? idempotency.execute(openId, requestId, action, operation)
        : operation();
    switch (action) {
      case 'session.bootstrap':
        return success(requestId, publicProfile(user, productMode));
      case 'session.qrCode': {
        return success(
          requestId,
          await write(async () => {
            if (productMode !== 'collaboration') {
              throw new BusinessError('FEATURE_DISABLED', '当前发布版本未开放好友二维码。');
            }
            if (user.qrCodeFileId !== undefined && user.qrCodeFileId !== null) {
              return { fileId: user.qrCodeFileId };
            }
            const code = await cloud.openapi.wxacode.getUnlimited({
              scene: `u=${user.publicId}`,
              page: 'pages/messages/index',
              checkPath: false,
              envVersion:
                process.env['MINIPROGRAM_ENV_VERSION'] === 'release'
                  ? 'release'
                  : process.env['MINIPROGRAM_ENV_VERSION'] === 'trial'
                    ? 'trial'
                    : 'develop',
            });
            if (code.buffer === undefined) {
              throw new BusinessError(
                'QR_CODE_FAILED',
                '暂时无法生成个人二维码，请稍后重试。',
                true,
              );
            }
            const uploaded = await cloud.uploadFile({
              cloudPath: `profile-codes/${user.id}.png`,
              fileContent: code.buffer,
            });
            await repository.updateUser({ ...user, qrCodeFileId: uploaded.fileID });
            return { fileId: uploaded.fileID };
          }),
        );
      }
      case 'session.updateProfile': {
        const updated = await write(() =>
          service.updateProfile(user, {
            displayName: requiredString(event.payload, 'displayName'),
            signature: requiredString(event.payload, 'signature'),
            avatarUrl: optionalNullableString(event.payload, 'avatarUrl'),
          }),
        );
        return success(requestId, publicProfile(updated, productMode));
      }
      case 'session.deleteAccount':
        await write(() => service.deleteAccount(user, socialRepository));
        await deleteUserFiles(user);
        return success(requestId, null);
      case 'social.search':
        return success(
          requestId,
          await social.searchByPublicId(user.id, requiredString(event.payload, 'publicId')),
        );
      case 'social.sendFriendRequest':
        return success(
          requestId,
          await write(() =>
            social.sendFriendRequest(user, requiredString(event.payload, 'publicId')),
          ),
        );
      case 'social.respondFriendRequest':
        return success(
          requestId,
          await write(() =>
            social.respondFriendRequest(
              user,
              requiredString(event.payload, 'requestId'),
              requiredBoolean(event.payload, 'accept'),
            ),
          ),
        );
      case 'social.listFriends':
        return success(requestId, await social.listFriends(user.id));
      case 'social.deleteFriend':
        await write(() =>
          social.deleteFriend(user.id, requiredString(event.payload, 'friendUserId')),
        );
        return success(requestId, null);
      case 'social.blockUser':
        await write(() =>
          social.blockUser(user.id, requiredString(event.payload, 'blockedUserId')),
        );
        return success(requestId, null);
      case 'social.listBlocked':
        return success(requestId, await social.listBlockedUsers(user.id));
      case 'social.unblockUser':
        await write(() =>
          social.unblockUser(user.id, requiredString(event.payload, 'blockedUserId')),
        );
        return success(requestId, null);
      case 'social.listNotifications':
        return success(requestId, await social.listNotifications(user.id));
      case 'social.markNotificationRead':
        await write(() =>
          social.markNotificationRead(user.id, requiredString(event.payload, 'notificationId')),
        );
        return success(requestId, null);
      case 'social.inviteToTrip':
        return success(
          requestId,
          await write(() =>
            social.inviteToTrip(
              user,
              requiredString(event.payload, 'tripId'),
              requiredString(event.payload, 'inviteeUserId'),
            ),
          ),
        );
      case 'social.leaveTrip':
        return success(
          requestId,
          await write(() => social.leaveTrip(user, requiredString(event.payload, 'tripId'))),
        );
      case 'social.respondTripInvitation':
        return success(
          requestId,
          await write(() =>
            social.respondTripInvitation(
              user,
              requiredString(event.payload, 'invitationId'),
              requiredBoolean(event.payload, 'accept'),
            ),
          ),
        );
      case 'trip.list':
        return success(requestId, await service.listTrips(user.id));
      case 'trip.listArchived':
        return success(requestId, await service.listArchivedTrips(user.id));
      case 'trip.get':
        return success(
          requestId,
          await service.getTrip(user.id, requiredString(event.payload, 'tripId')),
        );
      case 'trip.activity': {
        const tripId = requiredString(event.payload, 'tripId');
        await service.getTrip(user.id, tripId);
        return success(requestId, await socialRepository.listAuditLogs(tripId));
      }
      case 'trip.create': {
        const trip = await write(() =>
          service.createTrip(user, {
            name: requiredString(event.payload, 'name'),
          }),
        );
        return success(requestId, { tripId: trip.id, trip });
      }
      case 'trip.rename':
        return success(
          requestId,
          await write(() =>
            service.renameTrip(user.id, {
              tripId: requiredString(event.payload, 'tripId'),
              name: requiredString(event.payload, 'name'),
              expectedVersion: requiredInteger(event.payload, 'expectedVersion'),
            }),
          ),
        );
      case 'trip.addDate':
        return success(
          requestId,
          await write(() =>
            service.addDate(user.id, {
              tripId: requiredString(event.payload, 'tripId'),
              date: requiredString(event.payload, 'date'),
              expectedVersion: requiredInteger(event.payload, 'expectedVersion'),
            }),
          ),
        );
      case 'trip.deleteDate':
        return success(
          requestId,
          await write(() =>
            service.deleteDate(user.id, {
              tripId: requiredString(event.payload, 'tripId'),
              date: requiredString(event.payload, 'date'),
              expectedVersion: requiredInteger(event.payload, 'expectedVersion'),
            }),
          ),
        );
      case 'trip.addBill':
        return success(
          requestId,
          await write(() =>
            service.addBill(user.id, {
              tripId: requiredString(event.payload, 'tripId'),
              date: requiredString(event.payload, 'date'),
              expectedVersion: requiredInteger(event.payload, 'expectedVersion'),
              bill: requiredBill(event.payload),
            }),
          ),
        );
      case 'trip.updateBill':
        return success(
          requestId,
          await write(() =>
            service.updateBill(user.id, {
              tripId: requiredString(event.payload, 'tripId'),
              billId: requiredString(event.payload, 'billId'),
              date: requiredString(event.payload, 'date'),
              expectedVersion: requiredInteger(event.payload, 'expectedVersion'),
              bill: requiredBill(event.payload),
            }),
          ),
        );
      case 'trip.deleteBill':
        return success(
          requestId,
          await write(() =>
            service.deleteBill(user.id, {
              tripId: requiredString(event.payload, 'tripId'),
              billId: requiredString(event.payload, 'billId'),
              expectedVersion: requiredInteger(event.payload, 'expectedVersion'),
            }),
          ),
        );
      case 'trip.restoreBill':
        return success(
          requestId,
          await write(() =>
            service.restoreBill(user.id, {
              tripId: requiredString(event.payload, 'tripId'),
              billId: requiredString(event.payload, 'billId'),
              expectedVersion: requiredInteger(event.payload, 'expectedVersion'),
            }),
          ),
        );
      case 'trip.calculate':
        return success(
          requestId,
          await service.calculate(user.id, requiredString(event.payload, 'tripId')),
        );
      case 'trip.complete':
        return success(
          requestId,
          await write(() =>
            service.completeTrip(user.id, {
              tripId: requiredString(event.payload, 'tripId'),
              expectedVersion: requiredInteger(event.payload, 'expectedVersion'),
              ignoreInvalidBills: optionalBoolean(event.payload, 'ignoreInvalidBills'),
            }),
          ),
        );
      case 'trip.archive':
        return success(
          requestId,
          await write(() =>
            service.archiveTrip(user.id, {
              tripId: requiredString(event.payload, 'tripId'),
              expectedVersion: requiredInteger(event.payload, 'expectedVersion'),
            }),
          ),
        );
      case 'trip.reopen':
        return success(
          requestId,
          await write(() =>
            service.reopenTrip(user.id, {
              tripId: requiredString(event.payload, 'tripId'),
              expectedVersion: requiredInteger(event.payload, 'expectedVersion'),
            }),
          ),
        );
      case 'trip.restore':
        return success(
          requestId,
          await write(() =>
            service.restoreTrip(user.id, {
              tripId: requiredString(event.payload, 'tripId'),
              expectedVersion: requiredInteger(event.payload, 'expectedVersion'),
            }),
          ),
        );
      case 'trip.removeArchived':
        return success(
          requestId,
          await write(() =>
            service.removeArchivedTrip(user.id, {
              tripId: requiredString(event.payload, 'tripId'),
              expectedVersion: requiredInteger(event.payload, 'expectedVersion'),
            }),
          ),
        );
      default:
        return failure(requestId, 'UNKNOWN_ACTION', '无法识别该操作。');
    }
  } catch (error: unknown) {
    if (error instanceof BusinessError) {
      return failure(requestId, error.code, error.message, error.retryable, error.details);
    }
    console.error('cloud-api-unhandled', { action, requestId, error });
    return failure(requestId, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试。', true);
  }
}

async function deleteUserFiles(user: Awaited<ReturnType<LedgerService['bootstrapSession']>>) {
  const fileList = [user.avatarUrl, user.qrCodeFileId].filter(
    (value): value is string => typeof value === 'string' && value.startsWith('cloud://'),
  );
  if (fileList.length === 0) return;
  try {
    await cloud.deleteFile({ fileList });
  } catch {
    console.error('account-file-cleanup-failed', { userId: user.id, fileCount: fileList.length });
  }
}

function success<T>(requestId: string, data: T) {
  return { ok: true as const, requestId, data };
}

function failure(
  requestId: string,
  code: string,
  message: string,
  retryable = false,
  details?: Readonly<Record<string, unknown>>,
) {
  return { ok: false as const, requestId, error: { code, message, retryable, details } };
}

function publicProfile(
  user: Awaited<ReturnType<LedgerService['bootstrapSession']>>,
  productMode: 'solo' | 'collaboration',
) {
  return {
    userId: user.id,
    publicId: user.publicId,
    displayName: user.displayName,
    signature: user.signature,
    avatarUrl: user.avatarUrl,
    productMode,
  };
}

function requiredString(payload: unknown, key: string): string {
  const value = payloadValue(payload, key);
  if (typeof value !== 'string' || value.length === 0) {
    throw new BusinessError('REQUEST_INVALID', `字段 ${key} 必须是非空字符串。`);
  }
  return value;
}

function requiredInteger(payload: unknown, key: string): number {
  const value = payloadValue(payload, key);
  if (!Number.isSafeInteger(value)) {
    throw new BusinessError('REQUEST_INVALID', `字段 ${key} 必须是整数。`);
  }
  return value as number;
}

function optionalBoolean(payload: unknown, key: string): boolean {
  const value = payloadValue(payload, key);
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    throw new BusinessError('REQUEST_INVALID', `字段 ${key} 必须是布尔值。`);
  }
  return value;
}

function requiredBoolean(payload: unknown, key: string): boolean {
  const value = payloadValue(payload, key);
  if (typeof value !== 'boolean') {
    throw new BusinessError('REQUEST_INVALID', `字段 ${key} 必须是布尔值。`);
  }
  return value;
}

function optionalNullableString(payload: unknown, key: string): string | null {
  const value = payloadValue(payload, key);
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new BusinessError('REQUEST_INVALID', `字段 ${key} 必须是字符串。`);
  }
  return value;
}

function payloadValue(payload: unknown, key: string): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined;
  return (payload as Record<string, unknown>)[key];
}

function requiredBill(payload: unknown) {
  const value = payloadValue(payload, 'bill');
  if (typeof value !== 'object' || value === null) {
    throw new BusinessError('REQUEST_INVALID', '字段 bill 必须是账单对象。');
  }
  const bill = value as Record<string, unknown>;
  return {
    title: requiredNestedString(bill, 'title'),
    amountCents: requiredNestedInteger(bill, 'amountCents'),
    participants: requiredMemberAmounts(bill, 'participants', 'shares'),
    payers: requiredMemberAmounts(bill, 'payers', 'paidCents'),
  };
}

function requiredMemberAmounts(
  object: Record<string, unknown>,
  key: string,
  amountKey: 'shares',
): Array<{ memberId: string; displayName: string; shares: number }>;
function requiredMemberAmounts(
  object: Record<string, unknown>,
  key: string,
  amountKey: 'paidCents',
): Array<{ memberId: string; displayName: string; paidCents: number }>;
function requiredMemberAmounts(
  object: Record<string, unknown>,
  key: string,
  amountKey: 'shares' | 'paidCents',
) {
  const value = object[key];
  if (!Array.isArray(value)) {
    throw new BusinessError('REQUEST_INVALID', `字段 bill.${key} 必须是数组。`);
  }
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new BusinessError('REQUEST_INVALID', `字段 bill.${key}.${index} 格式不正确。`);
    }
    const record = item as Record<string, unknown>;
    return {
      memberId: requiredNestedString(record, 'memberId'),
      displayName: requiredNestedString(record, 'displayName'),
      [amountKey]: requiredNestedInteger(record, amountKey),
    };
  });
}

function requiredNestedString(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new BusinessError('REQUEST_INVALID', `字段 ${key} 必须是非空字符串。`);
  }
  return value;
}

function requiredNestedInteger(object: Record<string, unknown>, key: string): number {
  const value = object[key];
  if (!Number.isSafeInteger(value)) {
    throw new BusinessError('REQUEST_INVALID', `字段 ${key} 必须是整数。`);
  }
  return value as number;
}
