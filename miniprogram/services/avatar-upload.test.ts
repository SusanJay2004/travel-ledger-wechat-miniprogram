import { describe, expect, it } from 'vitest';

import { ApiError } from './api';
import { avatarSaveErrorMessage, canDiscardUploadedAvatar } from './avatar-upload';

describe('avatar upload uncertainty', () => {
  it('only discards a candidate after a server response proves it was not committed', () => {
    expect(canDiscardUploadedAvatar(new ApiError('CONTENT_REJECTED', '拒绝', false))).toBe(true);
    expect(canDiscardUploadedAvatar(new ApiError('PROFILE_VERSION_CONFLICT', '冲突', true))).toBe(
      true,
    );
    expect(canDiscardUploadedAvatar(new ApiError('REQUEST_RESULT_UNCERTAIN', '不确定', true))).toBe(
      false,
    );
    expect(canDiscardUploadedAvatar(new ApiError('REQUEST_IN_PROGRESS', '处理中', true))).toBe(
      false,
    );
    expect(canDiscardUploadedAvatar(new Error('callFunction:fail timeout'))).toBe(false);
  });

  it('explains why an unknown transport failure keeps the uploaded file', () => {
    expect(avatarSaveErrorMessage(new Error('timeout'))).toContain('为避免误删');
    expect(avatarSaveErrorMessage(new ApiError('CONTENT_REJECTED', '请更换图片', false))).toBe(
      '请更换图片',
    );
  });
});
