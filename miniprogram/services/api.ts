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

export async function callApi<T>(action: string, payload: unknown = {}): Promise<T> {
  if (wx.cloud === undefined) throw new Error('当前微信版本不支持云开发。');
  const requestId = createRequestId();
  const result = await wx.cloud.callFunction({
    name: 'api',
    data: { action, payload, requestId },
  });
  const response = result.result as ApiResponse<T>;
  if (response === undefined || response === null || typeof response !== 'object') {
    throw new Error('服务器返回了无法识别的数据。');
  }
  if (!response.ok)
    throw new ApiError(response.error.code, response.error.message, response.error.retryable);
  return response.data;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function createRequestId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${random}`;
}
