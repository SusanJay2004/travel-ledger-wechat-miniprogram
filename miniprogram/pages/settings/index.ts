import { callApi } from '../../services/api';
import { clearCachedSessionProfile } from '../../services/session';

interface SettingsData {
  deleting: boolean;
}

interface SettingsMethods {
  handleDeleteAccount(): Promise<void>;
  handleLegal(event: WechatMiniprogram.BaseEvent): void;
}

Page<SettingsData, SettingsMethods>({
  data: { deleting: false },

  handleLegal(event: WechatMiniprogram.BaseEvent) {
    const type = String(event.currentTarget.dataset['type'] ?? 'privacy');
    void wx.navigateTo({ url: `/pages/legal/index?type=${type}` });
  },

  async handleDeleteAccount() {
    if (this.data.deleting) return;
    const first = await wx.showModal({
      title: '注销账号？',
      content:
        '你的资料、好友和个人入口将删除；共享账单中的历史身份会匿名化，金额不会改变。此操作不可恢复。',
      confirmText: '继续注销',
      confirmColor: '#C84B4B',
    });
    if (!first.confirm) return;
    const final = await wx.showModal({
      title: '最后确认',
      content: '注销后再次进入会创建全新账号，无法找回旧行程。确认永久注销吗？',
      confirmText: '永久注销',
      confirmColor: '#C84B4B',
    });
    if (!final.confirm) return;
    this.setData({ deleting: true });
    try {
      await callApi('session.deleteAccount');
      clearCachedSessionProfile();
      wx.clearStorageSync();
      void wx.reLaunch({ url: '/pages/welcome/index' });
    } catch (error: unknown) {
      this.setData({ deleting: false });
      void wx.showModal({ title: '注销未完成', content: toMessage(error), showCancel: false });
    }
  },
});

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请稍后重试，期间不要继续修改行程。';
}
