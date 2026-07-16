export interface ApiSuccess<T> {
  ok: true;
  data: T;
  requestId: string;
}

export interface ApiFailure {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Readonly<Record<string, unknown>>;
  };
  requestId: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface TripSummary {
  id: string;
  name: string;
  status: 'active' | 'completed';
  startDate: string | null;
  endDate: string | null;
  totalCents: number;
  invalidBillCount: number;
  ledgerRevision: number;
}

export interface SessionProfile {
  userId: string;
  publicId: string;
  displayName: string;
  signature: string;
  avatarUrl: string | null;
}

export interface TripMember {
  userId: string;
  displayNameSnapshot: string;
  viewState: 'home' | 'archived' | 'detached';
  archivedAt: string | null;
  purgeAfter: string | null;
}

export interface BillParticipant {
  memberId: string;
  displayName: string;
  shares: number;
}

export interface BillPayer {
  memberId: string;
  displayName: string;
  paidCents: number;
}

export interface TripBill {
  id: string;
  date: string;
  title: string;
  amountCents: number;
  participants: readonly BillParticipant[];
  payers: readonly BillPayer[];
  validationCodes: readonly string[];
  createdAt: string;
  deletedAt: string | null;
}

export interface TripDetail {
  id: string;
  name: string;
  status: 'active' | 'completed';
  members: readonly TripMember[];
  dates: readonly string[];
  bills: readonly TripBill[];
  totalCents: number;
  invalidBillCount: number;
  version: number;
  ledgerRevision: number;
}

export interface SettlementTransfer {
  fromMemberId: string;
  toMemberId: string;
  amountCents: number;
}

export interface SettlementResponse {
  result: {
    transfers: readonly SettlementTransfer[];
    minimumTransferCount: number;
  };
  ignoredBillIds: readonly string[];
  includedCents: number;
  ledgerRevision: number;
}

export interface TripActivity {
  id: string;
  tripId: string;
  actorUserId: string;
  action: string;
  entityType: 'trip' | 'date' | 'bill' | 'member';
  entityId: string;
  beforeVersion: number;
  afterVersion: number;
  createdAt: string;
}

export interface PublicUserProfile {
  userId: string;
  publicId: string;
  displayName: string;
  signature: string;
  avatarUrl: string | null;
}

export interface FriendView extends PublicUserProfile {
  friendshipId: string;
}

export interface AppNotification {
  id: string;
  type:
    | 'friend_request'
    | 'friend_accepted'
    | 'trip_invitation'
    | 'member_joined'
    | 'member_left'
    | 'trip_completed'
    | 'trip_reopened';
  actorUserId: string | null;
  tripId: string | null;
  requestId: string | null;
  invitationId: string | null;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

export interface CallApiOptions {
  requestId?: string;
  transportRetries?: number;
}

export async function callApi<T>(
  action: string,
  payload: unknown = {},
  options: CallApiOptions = {},
): Promise<T> {
  if (wx.cloud === undefined) throw new Error('当前微信版本不支持云开发。');
  const requestId = options.requestId ?? createRequestId();
  const retries = options.transportRetries ?? 1;
  let result: Awaited<ReturnType<NonNullable<typeof wx.cloud>['callFunction']>>;
  for (let attempt = 0; ; attempt += 1) {
    try {
      result = await wx.cloud.callFunction({
        name: 'api',
        data: { action, payload, requestId },
      });
      break;
    } catch (error: unknown) {
      if (attempt >= retries) throw error;
    }
  }
  const response = result.result as ApiResponse<T>;
  if (response === undefined || response === null || typeof response !== 'object') {
    throw new Error('服务器返回了无法识别的数据。');
  }
  if (!response.ok) {
    throw new ApiError(
      response.error.code,
      response.error.message,
      response.error.retryable,
      response.error.details,
    );
  }
  return response.data;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function createRequestId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${random}`;
}
