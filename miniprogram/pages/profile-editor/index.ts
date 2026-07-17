import { callApi, type SessionProfile } from '../../services/api';
import {
  avatarSaveErrorMessage,
  canDiscardUploadedAvatar,
  clearPendingAvatarStage,
  stageAvatar,
} from '../../services/avatar-upload';
import { getSessionProfile, updateCachedSessionProfile } from '../../services/session';

interface ProfileEditorData {
  avatarUrl: string;
  avatarChanged: boolean;
  displayName: string;
  errorMessage: string;
  loading: boolean;
  saving: boolean;
  signature: string;
}

interface ProfileEditorMethods {
  handleAvatarChoose(event: WechatMiniprogram.CustomEvent<{ avatarUrl: string }>): void;
  handleNameInput(event: WechatMiniprogram.Input): void;
  handleSignatureInput(event: WechatMiniprogram.Input): void;
  handleSubmit(): Promise<void>;
  loadProfile(): Promise<void>;
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
  },

  onLoad() {
    void this.loadProfile();
  },

  async loadProfile() {
    try {
      const profile = await getSessionProfile(true);
      this.setData({
        avatarUrl: profile.avatarUrl ?? '',
        displayName: profile.displayName,
        loading: false,
        signature: profile.signature,
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
      const avatarToken = this.data.avatarChanged ? await stageAvatar(this.data.avatarUrl) : null;
      const updated = await callApi<SessionProfile>('session.updateProfile', {
        displayName,
        signature: this.data.signature.trim() || '这个人很懒，什么也没留下～',
        ...(this.data.avatarChanged ? { avatarToken } : {}),
      });
      updateCachedSessionProfile(updated);
      if (this.data.avatarChanged) clearPendingAvatarStage();
      if (updated.avatarReviewPending) {
        await wx.showToast({ icon: 'none', title: '新头像审核中，通过后自动显示' });
      }
      void wx.navigateBack();
    } catch (error: unknown) {
      if (this.data.avatarChanged && canDiscardUploadedAvatar(error)) clearPendingAvatarStage();
      this.setData({ errorMessage: avatarSaveErrorMessage(error), saving: false });
    }
  },
});

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : '保存失败，请稍后重试。';
}
