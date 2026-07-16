import { getSessionProfile, isLocalSessionSignedOut } from '../../services/session';

interface WelcomeData {
  accepted: boolean;
  errorMessage: string;
  loading: boolean;
}

interface WelcomeMethods {
  handleContinue(): Promise<void>;
  handleLegal(event: WechatMiniprogram.BaseEvent): void;
  toggleAccepted(): void;
}

Page<WelcomeData, WelcomeMethods>({
  data: { accepted: false, errorMessage: '', loading: false },

  onLoad() {
    const consented = wx.getStorageSync<boolean>('privacy-consent-v1') === true;
    this.setData({ accepted: consented });
    if (consented && !isLocalSessionSignedOut()) {
      void wx.switchTab({ url: '/pages/home/index' });
    }
  },

  toggleAccepted() {
    this.setData({ accepted: !this.data.accepted, errorMessage: '' });
  },

  handleLegal(event: WechatMiniprogram.BaseEvent) {
    const type = String(event.currentTarget.dataset['type'] ?? 'privacy');
    void wx.navigateTo({ url: `/pages/legal/index?type=${type}` });
  },

  async handleContinue() {
    if (!this.data.accepted) {
      this.setData({ errorMessage: '请先阅读并同意隐私保护指引和用户协议。' });
      return;
    }
    this.setData({ errorMessage: '', loading: true });
    try {
      await getSessionProfile();
      wx.setStorageSync('privacy-consent-v1', true);
      const pending = readPendingLaunch();
      wx.removeStorageSync('pending-launch-v1');
      if (pending !== null) {
        void wx.reLaunch({
          url: `/pages/messages/index?scene=${encodeURIComponent(pending.scene)}`,
        });
      } else {
        void wx.switchTab({ url: '/pages/home/index' });
      }
    } catch (error: unknown) {
      this.setData({ errorMessage: toMessage(error), loading: false });
    }
  },
});

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : '进入失败，请稍后重试。';
}

function readPendingLaunch(): { scene: string } | null {
  try {
    const value = wx.getStorageSync<unknown>('pending-launch-v1');
    if (
      typeof value !== 'object' ||
      value === null ||
      !('scene' in value) ||
      typeof value.scene !== 'string'
    ) {
      return null;
    }
    return { scene: value.scene };
  } catch {
    return null;
  }
}
