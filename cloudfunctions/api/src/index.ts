import { LIMITS, safeDiagnosticCode } from '@travel-ledger/domain';

import { CloudRepository, type CloudDatabase } from './cloud-repository';
import { CloudSocialRepository } from './cloud-social-repository';
import { WechatContentSecurity } from './content-security';
import { BusinessError } from './errors';
import { EventPublisher } from './event-publisher';
import { secureIdGenerator, systemClock } from './generators';
import {
  IdempotencyService,
  isKnownAction,
  isWriteAction,
  requestPayloadHash,
} from './idempotency';
import { LedgerService } from './service';
import { RateLimiter } from './rate-limit';
import { failureResponse, successResponse } from './response';
import { SocialService } from './social-service';
import { CloudTripInvitationAcceptance } from './trip-invitation-transaction';
import { CloudFriendRequestTransition } from './friend-request-transaction';
import { CloudSocialRelationshipTransition } from './social-relationship-transaction';
import { deleteFilesCompletely, type DeleteFileResultItem } from './file-deletion';
import { attachTemporaryAvatarUrls, temporaryDisplayUrl } from './file-access';
import { stageAvatar } from './avatar-staging';
import type { UserDocument } from './models';

export interface ApiEvent {
  action?: unknown;
  payload?: unknown;
  requestId?: unknown;
}

interface CloudContext {
  OPENID?: string;
}

export interface CloudSdk {
  DYNAMIC_CURRENT_ENV: symbol;
  database(): CloudDatabase;
  deleteFile(options: { fileList: string[] }): Promise<{
    fileList: readonly DeleteFileResultItem[];
  }>;
  getWXContext(): CloudContext;
  init(options: { env: symbol }): void;
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
  getTempFileURL(options: { fileList: (string | { fileID: string; maxAge?: number })[] }): Promise<{
    fileList: readonly { fileID: string; tempFileURL: string; status: number }[];
  }>;
  uploadFile(options: { cloudPath: string; fileContent: Buffer }): Promise<{ fileID: string }>;
}

export async function main(event: ApiEvent): Promise<unknown> {
  return handleApiInvocation(event, runtimeCloud);
}

export async function handleApiInvocation(
  event: ApiEvent,
  cloudFactory: () => CloudSdk,
): Promise<unknown> {
  try {
    return await handleApiEvent(event, cloudFactory());
  } catch (error: unknown) {
    const requestId = safeRequestId(event.requestId);
    console.error('cloud-api-entry-failed', {
      action: safeAction(event.action),
      errorCode: safeDiagnosticCode(error),
      requestId,
    });
    return failure(requestId, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试。', true);
  }
}

let initializedCloud: CloudSdk | null = null;

function runtimeCloud(): CloudSdk {
  if (initializedCloud !== null) return initializedCloud;
  // wx-server-sdk is installed by the cloud function workspace and loaded by the cloud runtime.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sdk = require('wx-server-sdk') as CloudSdk;
  sdk.init({ env: sdk.DYNAMIC_CURRENT_ENV });
  initializedCloud = sdk;
  return sdk;
}

export async function handleApiEvent(
  event: ApiEvent,
  sdk: CloudSdk,
  dependencies: { avatarDownloader?: (url: string) => Promise<Buffer> } = {},
): Promise<unknown> {
  const requestId = typeof event.requestId === 'string' ? event.requestId : 'missing-request-id';
  const action = typeof event.action === 'string' ? event.action : '';
  const openId = sdk.getWXContext().OPENID;

  if (openId === undefined || openId.length === 0) {
    return failure(requestId, 'UNAUTHENTICATED', '无法识别当前微信用户，请重新进入小程序。');
  }
  if (!/^[A-Za-z0-9-]{8,80}$/.test(requestId)) {
    return failure(requestId, 'REQUEST_ID_INVALID', '请求标识格式不正确。');
  }

  const database = sdk.database();
  const repository = new CloudRepository(database);
  const socialRepository = new CloudSocialRepository(database);
  const publisher = new EventPublisher(socialRepository, repository);
  const idempotency = new IdempotencyService(database, systemClock);
  const rateLimiter = new RateLimiter(database, systemClock);
  const contentSecurity = new WechatContentSecurity(
    sdk,
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
    new CloudTripInvitationAcceptance(database),
    new CloudFriendRequestTransition(database),
    new CloudSocialRelationshipTransition(database),
  );

  try {
    // Validate a bounded JSON shape for reads and writes before any database or domain work.
    const structuralPayloadHash = requestPayloadHash(event.payload);
    if (!isKnownAction(action)) {
      throw new BusinessError('UNKNOWN_ACTION', '无法识别该操作。');
    }
    const payloadHash =
      action === 'session.stageAvatar'
        ? requestPayloadHash({
            avatarToken: requiredString(event.payload, 'avatarToken'),
            sha256: requiredString(event.payload, 'sha256'),
            size: requiredInteger(event.payload, 'size'),
          })
        : structuralPayloadHash;
    await rateLimiter.consume(openId, requestId, action, payloadHash);
    const existingUser = await repository.findUserByOpenId(openId);
    if (action === 'session.deleteAccount' && existingUser === null) {
      await idempotency.executeWithPayloadHash(
        openId,
        requestId,
        action,
        payloadHash,
        async () => null,
      );
      return success(requestId, null);
    }
    if (action === 'session.bootstrap' && existingUser?.status === 'deleting') {
      // A cloud-function timeout can happen after the irreversible deletion marker commits.
      // Resuming here keeps the recovery path reachable even when the original idempotency
      // record is still processing and the user can no longer open the settings page.
      await service.deleteAccount(existingUser, socialRepository);
      await cleanPendingUserFiles(sdk, repository, existingUser.id);
      const replacement = await service.bootstrapSession(openId);
      return success(requestId, await displaySessionProfile(sdk, replacement, productMode));
    }
    const user =
      action === 'session.deleteAccount' && existingUser?.status === 'deleting'
        ? existingUser
        : await service.bootstrapSession(openId);
    const write = <T>(operation: () => Promise<T>) =>
      isWriteAction(action)
        ? idempotency.executeWithPayloadHash(openId, requestId, action, payloadHash, operation)
        : operation();
    switch (action) {
      case 'session.bootstrap':
        return success(requestId, await displaySessionProfile(sdk, user, productMode));
      case 'session.stageAvatar': {
        const staged = await write(() =>
          stageAvatar(
            repository,
            {
              delete: async (fileId) => deleteFilesCompletely(sdk, [fileId]),
              upload: async (cloudPath, fileContent) =>
                (await sdk.uploadFile({ cloudPath, fileContent })).fileID,
            },
            systemClock,
            user,
            {
              avatarToken: requiredString(event.payload, 'avatarToken'),
              sha256: requiredString(event.payload, 'sha256'),
              size: requiredInteger(event.payload, 'size'),
              sourceUrl: requiredString(event.payload, 'sourceUrl'),
            },
            dependencies.avatarDownloader,
          ),
        );
        await cleanPendingUserFiles(sdk, repository, user.id);
        return success(requestId, staged);
      }
      case 'session.qrCode': {
        const code = await write(async () => {
          if (productMode !== 'collaboration') {
            throw new BusinessError('FEATURE_DISABLED', '当前发布版本未开放好友二维码。');
          }
          if (
            user.qrCodeFileId !== undefined &&
            user.qrCodeFileId !== null &&
            user.qrSceneToken !== undefined &&
            user.qrSceneToken !== null
          ) {
            return { fileId: user.qrCodeFileId };
          }
          const qrSceneToken = secureIdGenerator.sceneToken();
          const code = await sdk.openapi.wxacode.getUnlimited({
            scene: `t=${qrSceneToken}`,
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
            throw new BusinessError('QR_CODE_FAILED', '暂时无法生成个人二维码，请稍后重试。', true);
          }
          const uploaded = await sdk.uploadFile({
            cloudPath: `profile-codes/${user.id}/${qrSceneToken}.png`,
            fileContent: code.buffer,
          });
          try {
            const updated = await repository.updateUser(
              {
                ...user,
                qrCodeFileId: uploaded.fileID,
                qrSceneToken,
                version: user.version + 1,
                updatedAt: systemClock.now().toISOString(),
              },
              user.version,
            );
            if (!updated) {
              throw new BusinessError(
                'PROFILE_VERSION_CONFLICT',
                '个人资料刚刚发生变化，请重新生成二维码。',
                true,
              );
            }
          } catch (error: unknown) {
            await deleteFilesCompletely(sdk, [uploaded.fileID]).catch(() => undefined);
            if (error instanceof BusinessError) throw error;
            throw new BusinessError('QR_CODE_FAILED', '二维码资料保存失败，请稍后重试。', true);
          }
          return { fileId: uploaded.fileID };
        });
        const url = await temporaryDisplayUrl(sdk, code.fileId);
        if (url === null) {
          throw new BusinessError('QR_CODE_URL_FAILED', '二维码暂时无法显示，请稍后重试。', true);
        }
        return success(requestId, { url });
      }
      case 'session.updateProfile': {
        if (payloadValue(event.payload, 'avatarUrl') !== undefined) {
          throw new BusinessError(
            'REQUEST_INVALID',
            '头像必须通过受控暂存后使用 avatarToken 保存。',
          );
        }
        const avatarToken = optionalNullableString(event.payload, 'avatarToken');
        const updated = await write(() => {
          const avatarChange =
            avatarToken === undefined
              ? {}
              : {
                  avatarUrl: resolveStagedAvatar(user, avatarToken, systemClock.now()),
                  consumeStagedAvatar: true as const,
                };
          return service.updateProfile(user, {
            displayName: requiredString(event.payload, 'displayName'),
            signature: requiredString(event.payload, 'signature'),
            ...avatarChange,
          });
        });
        await cleanPendingUserFiles(sdk, repository, updated.id);
        return success(requestId, await displaySessionProfile(sdk, updated, productMode));
      }
      case 'session.deleteAccount':
        await write(async () => {
          await service.deleteAccount(user, socialRepository);
          await cleanPendingUserFiles(sdk, repository, user.id);
        });
        return success(requestId, null);
      case 'social.search':
        return success(
          requestId,
          await displayOptionalProfile(
            sdk,
            await social.searchByPublicId(user.id, requiredString(event.payload, 'publicId')),
          ),
        );
      case 'social.resolveQrScene':
        return success(
          requestId,
          await displayOptionalProfile(
            sdk,
            await social.resolveQrScene(user.id, requiredString(event.payload, 'token')),
          ),
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
        return success(
          requestId,
          await attachTemporaryAvatarUrls(sdk, await social.listFriends(user.id)),
        );
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
        return success(
          requestId,
          await attachTemporaryAvatarUrls(sdk, await social.listBlockedUsers(user.id)),
        );
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
      case 'trip.clearArchived':
        return success(requestId, await write(() => service.clearArchivedTrips(user.id)));
      default:
        return failure(requestId, 'UNKNOWN_ACTION', '无法识别该操作。');
    }
  } catch (error: unknown) {
    if (error instanceof BusinessError) {
      return failure(requestId, error.code, error.message, error.retryable, error.details);
    }
    console.error('cloud-api-unhandled', {
      action,
      errorCode: safeDiagnosticCode(error),
      requestId,
    });
    return failure(requestId, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试。', true);
  }
}

function safeRequestId(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{8,80}$/.test(value)
    ? value
    : 'missing-request-id';
}

function safeAction(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9.]{0,63}$/.test(value)
    ? value
    : 'invalid';
}

async function cleanPendingUserFiles(sdk: CloudSdk, repository: CloudRepository, userId: string) {
  const user = await repository.getUser(userId);
  if (user === null) return;
  const markedFiles = user.pendingFileDeletionIds ?? [];
  if (markedFiles.length === 0) return;
  const fileList = deletableUserFiles(user);
  try {
    if (fileList.length > 0) await deleteFilesCompletely(sdk, fileList);
    const cleared = await repository.updateUser(
      {
        ...user,
        pendingFileDeletionIds: [],
        version: user.version + 1,
        updatedAt: systemClock.now().toISOString(),
      },
      user.version,
    );
    if (!cleared) {
      console.error('account-file-cleanup-conflict', { userId, fileCount: fileList.length });
    }
  } catch {
    console.error('account-file-cleanup-failed', { userId, fileCount: fileList.length });
  }
}

function deletableUserFiles(user: UserDocument): readonly string[] {
  const referenced = new Set(
    [user.avatarUrl, user.pendingAvatarFileId, user.stagedAvatarFileId, user.qrCodeFileId].filter(
      (value): value is string => typeof value === 'string' && value.startsWith('cloud://'),
    ),
  );
  return [...new Set(user.pendingFileDeletionIds ?? [])].filter(
    (fileId) => fileId.startsWith('cloud://') && !referenced.has(fileId),
  );
}

function success<T>(requestId: string, data: T) {
  return successResponse(requestId, data);
}

function failure(
  requestId: string,
  code: string,
  message: string,
  retryable = false,
  details?: Readonly<Record<string, unknown>>,
) {
  return failureResponse(requestId, code, message, retryable, details);
}

function publicProfile(
  user: Awaited<ReturnType<LedgerService['bootstrapSession']>>,
  productMode: 'solo' | 'collaboration',
  avatarReviewPending = user.pendingAvatarReviewId !== null &&
    user.pendingAvatarReviewId !== undefined,
) {
  return {
    userId: user.id,
    publicId: user.publicId,
    displayName: user.displayName,
    signature: user.signature,
    avatarUrl: user.avatarUrl,
    avatarReviewPending,
    productMode,
  };
}

async function displaySessionProfile(
  sdk: CloudSdk,
  user: Awaited<ReturnType<LedgerService['bootstrapSession']>>,
  productMode: 'solo' | 'collaboration',
) {
  const profile = publicProfile(user, productMode);
  const [displayed] = await attachTemporaryAvatarUrls(sdk, [profile]);
  return displayed!;
}

async function displayOptionalProfile<T extends { avatarUrl: string | null }>(
  sdk: CloudSdk,
  profile: T | null,
): Promise<T | null> {
  if (profile === null) return null;
  const [displayed] = await attachTemporaryAvatarUrls(sdk, [profile]);
  return displayed ?? null;
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

function optionalNullableString(payload: unknown, key: string): string | null | undefined {
  const value = payloadValue(payload, key);
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new BusinessError('REQUEST_INVALID', `字段 ${key} 必须是字符串。`);
  }
  return value;
}

function resolveStagedAvatar(
  user: Awaited<ReturnType<LedgerService['bootstrapSession']>>,
  avatarToken: string | null,
  now: Date,
): string | null {
  if (avatarToken === null) return null;
  const expiresAt = Date.parse(user.stagedAvatarExpiresAt ?? '');
  if (
    user.stagedAvatarToken !== avatarToken ||
    user.stagedAvatarFileId?.startsWith('cloud://') !== true ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now.getTime()
  ) {
    throw new BusinessError('AVATAR_STAGE_EXPIRED', '头像暂存已失效，请重新选择。');
  }
  return user.stagedAvatarFileId;
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
  if (value.length > LIMITS.membersPerTrip) {
    throw new BusinessError(
      'REQUEST_INVALID',
      `字段 bill.${key} 最多包含 ${LIMITS.membersPerTrip} 人。`,
    );
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
