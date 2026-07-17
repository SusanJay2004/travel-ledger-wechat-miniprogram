import { ApiError } from './api';

const DEFINITELY_REJECTED_CODES = new Set([
  'ACCOUNT_DELETION_PENDING',
  'AVATAR_OWNERSHIP_INVALID',
  'AVATAR_TOO_LARGE',
  'AVATAR_TYPE_INVALID',
  'AVATAR_URL_INVALID',
  'CONTENT_CHECK_UNAVAILABLE',
  'CONTENT_REJECTED',
  'PROFILE_VERSION_CONFLICT',
  'RATE_LIMITED',
  'REQUEST_INVALID',
  'SIGNATURE_INVALID',
  'USERNAME_INVALID',
]);

export function canDiscardUploadedAvatar(error: unknown): boolean {
  return error instanceof ApiError && DEFINITELY_REJECTED_CODES.has(error.code);
}

export function avatarSaveErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return '保存结果暂时无法确认，请重新进入资料页核对；为避免误删，刚上传的头像已保留。';
}
