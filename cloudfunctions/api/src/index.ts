import { CloudRepository, type CloudDatabase } from './cloud-repository';
import { BusinessError } from './errors';
import { secureIdGenerator, systemClock } from './generators';
import { LedgerService } from './service';

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
  getWXContext(): CloudContext;
  init(options: { env: symbol }): void;
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

  const service = new LedgerService(
    new CloudRepository(cloud.database()),
    systemClock,
    secureIdGenerator,
  );

  try {
    const user = await service.bootstrapSession(openId);
    switch (action) {
      case 'session.bootstrap':
        return success(requestId, publicProfile(user));
      case 'trip.list':
        return success(requestId, await service.listTrips(user.id));
      case 'trip.listArchived':
        return success(requestId, await service.listArchivedTrips(user.id));
      case 'trip.get':
        return success(
          requestId,
          await service.getTrip(user.id, requiredString(event.payload, 'tripId')),
        );
      case 'trip.create': {
        const trip = await service.createTrip(user, {
          name: requiredString(event.payload, 'name'),
        });
        return success(requestId, { tripId: trip.id, trip });
      }
      case 'trip.addDate':
        return success(
          requestId,
          await service.addDate(user.id, {
            tripId: requiredString(event.payload, 'tripId'),
            date: requiredString(event.payload, 'date'),
            expectedVersion: requiredInteger(event.payload, 'expectedVersion'),
          }),
        );
      case 'trip.addBill':
        return success(
          requestId,
          await service.addBill(user.id, {
            tripId: requiredString(event.payload, 'tripId'),
            date: requiredString(event.payload, 'date'),
            expectedVersion: requiredInteger(event.payload, 'expectedVersion'),
            bill: requiredBill(event.payload),
          }),
        );
      case 'trip.calculate':
        return success(
          requestId,
          await service.calculate(user.id, requiredString(event.payload, 'tripId')),
        );
      case 'trip.complete':
        return success(
          requestId,
          await service.completeTrip(user.id, {
            tripId: requiredString(event.payload, 'tripId'),
            expectedVersion: requiredInteger(event.payload, 'expectedVersion'),
            ignoreInvalidBills: optionalBoolean(event.payload, 'ignoreInvalidBills'),
          }),
        );
      case 'trip.archive':
        return success(
          requestId,
          await service.archiveTrip(user.id, {
            tripId: requiredString(event.payload, 'tripId'),
            expectedVersion: requiredInteger(event.payload, 'expectedVersion'),
          }),
        );
      case 'trip.reopen':
        return success(
          requestId,
          await service.reopenTrip(user.id, {
            tripId: requiredString(event.payload, 'tripId'),
            expectedVersion: requiredInteger(event.payload, 'expectedVersion'),
          }),
        );
      case 'trip.restore':
        return success(
          requestId,
          await service.restoreTrip(user.id, {
            tripId: requiredString(event.payload, 'tripId'),
            expectedVersion: requiredInteger(event.payload, 'expectedVersion'),
          }),
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

function publicProfile(user: Awaited<ReturnType<LedgerService['bootstrapSession']>>) {
  return {
    userId: user.id,
    publicId: user.publicId,
    displayName: user.displayName,
    signature: user.signature,
    avatarUrl: user.avatarUrl,
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
