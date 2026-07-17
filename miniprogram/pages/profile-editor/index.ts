import { callApi, type SessionProfile } from '../../services/api';
import { avatarSaveErrorMessage, canDiscardUploadedAvatar } from '../../services/avatar-upload';
import { getSessionProfile, updateCachedSessionProfile } from '../../services/session';

interface ProfileEditorData {
  avatarUrl: string;
  avatarChanged: boolean;
  displayName: string;
  errorMessage: string;
  loading: boolean;
  saving: boolean;
  signature: string;
  originalAvatarUrl: string;
  userId: string;
}

interface ProfileEditorMethods {
  handleAvatarChoose(event: WechatMiniprogram.CustomEvent<{ avatarUrl: string }>): void;
  handleNameInput(event: WechatMiniprogram.Input): void;
  handleSignatureInput(event: WechatMiniprogram.Input): void;
  handleSubmit(): Promise<void>;
  loadProfile(): Promise<void>;
  uploadAvatar(localPath: string): Promise<string>;
}

Page<ProfileEditorData, ProfileEditorMethods>({
  data: {
    avatarUrl: '',
    avatarChanged: false,
    displayName: '',
    errorMessage: '',
    loading: true,
    saving: false,
    signature: '',
    originalAvatarUrl: '',
    userId: '',
  },

  onLoad() {
    void this.loadProfile();
  },

  async loadProfile() {
    try {
      const profile = await getSessionProfile();
      this.setData({
        avatarUrl: profile.avatarUrl ?? '',
        displayName: profile.displayName,
        loading: false,
        originalAvatarUrl: profile.avatarUrl ?? '',
        signature: profile.signature,
        userId: profile.userId,
      });
    } catch (error: unknown) {
      this.setData({ errorMessage: toMessage(error), loading: false });
    }
  },

  handleAvatarChoose(event: WechatMiniprogram.CustomEvent<{ avatarUrl: string }>) {
    this.setData({ avatarChanged: true, avatarUrl: event.detail.avatarUrl });
  },

  handleNameInput(event: WechatMiniprogram.Input) {
    this.setData({ displayName: event.detail.value });
  },

  handleSignatureInput(event: WechatMiniprogram.Input) {
    this.setData({ signature: event.detail.value });
  },

  async handleSubmit() {
    if (this.data.saving) return;
    const displayName = this.data.displayName.trim();
    if (!/^[\u3400-\u9fffA-Za-z0-9]{2,16}$/.test(displayName)) {
      this.setData({ errorMessage: '用户名须为 2–16 个中文、英文字母或数字。' });
      return;
    }
    if ([...this.data.signature].length > 60) {
      this.setData({ errorMessage: '个人签名不能超过 60 个字符。' });
      return;
    }
    this.setData({ errorMessage: '', saving: true });
    try {
      const uploadedAvatar = this.data.avatarChanged
        ? await this.uploadAvatar(this.data.avatarUrl)
        : null;
      let updated: SessionProfile;
      try {
        updated = await callApi<SessionProfile>('session.updateProfile', {
          displayName,
          signature: this.data.signature.trim() || '这个人很懒，什么也没留下～',
          avatarUrl: uploadedAvatar ?? (this.data.avatarUrl || null),
        });
      } catch (error: unknown) {
        if (uploadedAvatar !== null && canDiscardUploadedAvatar(error)) {
          await deleteCloudFile(uploadedAvatar);
        }
        throw error;
      }
      updateCachedSessionProfile(updated);
      if (updated.avatarReviewPending) {
        await wx.showToast({ icon: 'none', title: '新头像审核中，通过后自动显示' });
      }
      void wx.navigateBack();
    } catch (error: unknown) {
      this.setData({ errorMessage: avatarSaveErrorMessage(error), saving: false });
    }
  },

  async uploadAvatar(localPath: string) {
    if (wx.cloud === undefined) throw new Error('当前微信版本不支持云存储。');
    if (this.data.userId.length === 0) throw new Error('账号资料尚未加载，请稍后重试。');
    const extension = /\.([A-Za-z0-9]+)$/.exec(localPath)?.[1]?.toLowerCase() ?? 'jpg';
    const safeExtension = ['jpg', 'jpeg', 'png'].includes(extension) ? extension : 'jpg';
    const result = await wx.cloud.uploadFile({
      cloudPath: `avatars/${this.data.userId}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${safeExtension}`,
      filePath: localPath,
    });
    return result.fileID;
  },
});

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : '保存失败，请稍后重试。';
}

async function deleteCloudFile(fileId: string): Promise<void> {
  try {
    await wx.cloud?.deleteFile({ fileList: [fileId] });
  } catch {
    console.warn('avatar-cleanup-failed');
  }
}
