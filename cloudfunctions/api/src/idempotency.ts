import { createHash } from 'node:crypto';

import type { CloudDatabase } from './cloud-repository';
import { BusinessError } from './errors';
import type { Clock, IdempotencyRecordDocument } from './models';

interface AddError {
  errCode?: string | number;
  message?: string;
}

interface PayloadBudget {
  nodes: number;
  stringCodeUnits: number;
}

const MAX_PAYLOAD_DEPTH = 8;
const MAX_PAYLOAD_NODES = 256;
const MAX_PAYLOAD_STRING_CODE_UNITS = 16_384;
const READ_ACTIONS = new Set([
  'session.bootstrap',
  'social.search',
  'social.resolveQrScene',
  'social.listFriends',
  'social.listBlocked',
  'social.listNotifications',
  'trip.list',
  'trip.listArchived',
  'trip.get',
  'trip.activity',
  'trip.calculate',
]);
const WRITE_ACTIONS = new Set([
  'session.updateProfile',
  'session.deleteAccount',
  'session.qrCode',
  'trip.create',
  'trip.rename',
  'trip.addDate',
  'trip.deleteDate',
  'trip.addBill',
  'trip.updateBill',
  'trip.deleteBill',
  'trip.restoreBill',
  'trip.complete',
  'trip.reopen',
  'trip.archive',
  'trip.restore',
  'trip.removeArchived',
  'trip.clearArchived',
  'social.sendFriendRequest',
  'social.respondFriendRequest',
  'social.deleteFriend',
  'social.blockUser',
  'social.unblockUser',
  'social.markNotificationRead',
  'social.inviteToTrip',
  'social.leaveTrip',
  'social.respondTripInvitation',
]);

export class IdempotencyService {
  constructor(
    private readonly db: CloudDatabase,
    private readonly clock: Clock,
  ) {}

  async execute<T>(
    ownerOpenId: string,
    requestId: string,
    action: string,
    payload: unknown,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.executeWithPayloadHash(
      ownerOpenId,
      requestId,
      action,
      requestPayloadHash(payload),
      operation,
    );
  }

  async executeWithPayloadHash<T>(
    ownerOpenId: string,
    requestId: string,
    action: string,
    payloadHash: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    validateRequestId(requestId);
    if (!/^[a-f0-9]{64}$/.test(payloadHash)) {
      throw new BusinessError('REQUEST_INVALID', '请求内容摘要无效。');
    }
    const id = recordId(ownerOpenId, requestId);
    const collection = this.db.collection<IdempotencyRecordDocument>('idempotency_records');
    const existing = await getRecord(collection, id);
    if (existing !== null) return resolveExisting<T>(existing, action, payloadHash);

    const now = this.clock.now();
    const record: IdempotencyRecordDocument & { _id: string } = {
      _id: id,
      id,
      ownerOpenId,
      requestId,
      action,
      payloadHash,
      status: 'processing',
      response: null,
      error: null,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    };
    try {
      await collection.add({ data: record });
    } catch (error: unknown) {
      if (!isDuplicateError(error)) throw error;
      const raced = await getRecord(collection, id);
      if (raced !== null) return resolveExisting<T>(raced, action, payloadHash);
      throw error;
    }

    let response: T;
    try {
      response = await operation();
    } catch (error: unknown) {
      const serialized = serializeError(error);
      await collection
        .doc(id)
        .set({ data: { ...record, status: 'failed', error: serialized } })
        .catch(() => undefined);
      throw toBusinessError(serialized);
    }

    try {
      await collection.doc(id).set({
        data: { ...record, status: 'completed', response, error: null },
      });
    } catch {
      // The domain command may already have committed. Keep the processing marker so the
      // same request can never be replayed and ask the caller to refresh authoritative data.
      throw new BusinessError(
        'REQUEST_RESULT_UNCERTAIN',
        '操作可能已经完成，请刷新页面确认，切勿重复提交。',
        true,
      );
    }
    return response;
  }
}

export function isWriteAction(action: string): boolean {
  return WRITE_ACTIONS.has(action);
}

export function isKnownAction(action: string): boolean {
  return READ_ACTIONS.has(action) || WRITE_ACTIONS.has(action);
}

function validateRequestId(requestId: string): void {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(requestId)) {
    throw new BusinessError('REQUEST_ID_INVALID', '请求标识格式不正确。');
  }
}

function recordId(ownerOpenId: string, requestId: string): string {
  return createHash('sha256').update(`${ownerOpenId}:${requestId}`).digest('hex');
}

async function getRecord(
  collection: ReturnType<CloudDatabase['collection']>,
  id: string,
): Promise<IdempotencyRecordDocument | null> {
  try {
    return (await collection.doc(id).get()).data as IdempotencyRecordDocument;
  } catch (error: unknown) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function resolveExisting<T>(
  record: IdempotencyRecordDocument,
  action: string,
  payloadHash: string,
): T {
  if (record.action !== action || record.payloadHash !== payloadHash) {
    throw new BusinessError('REQUEST_ID_REUSED', '同一请求标识不能用于不同操作或内容。');
  }
  if (record.status === 'failed' && record.error !== null) {
    throw toBusinessError(record.error);
  }
  if (record.status !== 'completed') {
    throw new BusinessError('REQUEST_IN_PROGRESS', '请求正在处理中，请稍后刷新。', true);
  }
  return record.response as T;
}

export function requestPayloadHash(payload: unknown): string {
  const canonical =
    JSON.stringify(
      sortJsonValue(payload, 0, { nodes: 0, stringCodeUnits: 0 }, new WeakSet<object>()),
    ) ?? 'null';
  return createHash('sha256').update(canonical).digest('hex');
}

function sortJsonValue(
  value: unknown,
  depth: number,
  budget: PayloadBudget,
  ancestors: WeakSet<object>,
): unknown {
  budget.nodes += 1;
  if (depth > MAX_PAYLOAD_DEPTH || budget.nodes > MAX_PAYLOAD_NODES) {
    throw new BusinessError('REQUEST_INVALID', '请求内容层级过深或字段过多。');
  }
  if (typeof value === 'string') {
    consumePayloadString(value, budget);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new BusinessError('REQUEST_INVALID', '请求内容包含无效数字。');
    }
    return value;
  }
  if (typeof value === 'boolean' || value === null || value === undefined) return value;
  if (typeof value !== 'object') {
    throw new BusinessError('REQUEST_INVALID', '请求内容不是有效的 JSON 数据。');
  }
  if (ancestors.has(value)) {
    throw new BusinessError('REQUEST_INVALID', '请求内容不能循环引用。');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_PAYLOAD_NODES) {
        throw new BusinessError('REQUEST_INVALID', '请求内容字段过多。');
      }
      return value.map((item) => sortJsonValue(item, depth + 1, budget, ancestors));
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new BusinessError('REQUEST_INVALID', '请求内容不是普通 JSON 对象。');
    }
    const entries = Object.entries(value);
    if (entries.length > MAX_PAYLOAD_NODES) {
      throw new BusinessError('REQUEST_INVALID', '请求内容字段过多。');
    }
    return Object.fromEntries(
      entries
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => {
          consumePayloadString(key, budget);
          return [key, sortJsonValue(item, depth + 1, budget, ancestors)];
        }),
    );
  } finally {
    ancestors.delete(value);
  }
}

function consumePayloadString(value: string, budget: PayloadBudget): void {
  budget.stringCodeUnits += value.length;
  if (budget.stringCodeUnits > MAX_PAYLOAD_STRING_CODE_UNITS) {
    throw new BusinessError('REQUEST_INVALID', '请求内容过大。');
  }
}

function serializeError(error: unknown): NonNullable<IdempotencyRecordDocument['error']> {
  if (error instanceof BusinessError) {
    const serialized: NonNullable<IdempotencyRecordDocument['error']> = {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
    if (error.details !== undefined) serialized.details = error.details;
    return serialized;
  }
  return {
    code: 'INTERNAL_ERROR',
    message: '服务暂时不可用，请稍后刷新确认。',
    retryable: true,
  };
}

function toBusinessError(error: NonNullable<IdempotencyRecordDocument['error']>): BusinessError {
  return new BusinessError(error.code, error.message, error.retryable, error.details);
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as AddError;
  return (
    String(candidate.errCode ?? '').includes('DOCUMENT_NOT_FOUND') ||
    String(candidate.message ?? '')
      .toLowerCase()
      .includes('not found')
  );
}

function isDuplicateError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as AddError;
  const value =
    `${String(candidate.errCode ?? '')} ${String(candidate.message ?? '')}`.toLowerCase();
  return value.includes('duplicate') || value.includes('already exists');
}
