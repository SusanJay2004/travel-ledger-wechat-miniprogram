import { callApi } from '../../services/api';
import { clearCachedSessionProfile, signOutLocalSession } from '../../services/session';

interface SettingsData {
  deleting: boolean;
  signingOut: boolean;
}

interface SettingsMethods {
  handleDeleteAccount(): Promise<void>;
  handleLegal(event: WechatMiniprogram.BaseEvent): void;
  handleSignOut(): Promise<void>;
}

Page<SettingsData, SettingsMethods>({
  data: { deleting: false, signingOut: false },

  handleLegal(event: WechatMiniprogram.BaseEvent) {
    const type = String(event.currentTarget.dataset['type'] ?? 'privacy');
    void wx.navigateTo({ url: `/pages/legal/index?type=${type}` });
  },

  async handleSignOut() {
    if (this.data.signingOut || this.data.deleting) return;
    const result = await wx.showModal({
      title: '退出当前登录？',
      content: '只会清除本机登录状态、离线缓存和未提交草稿；账号与云端行程不会删除。',
      confirmText: '退出登录',
      confirmColor: '#167D73',
    });
    if (!result.confirm) return;
    this.setData({ signingOut: true });
    try {
      signOutLocalSession();
    } catch {
      this.setData({ signingOut: false });
      void wx.showToast({ icon: 'none', title: '本机存储不可用，暂时无法退出' });
      return;
    }
    void wx.removeTabBarBadge({ index: 1 }).catch(() => undefined);
    void wx.reLaunch({ url: '/pages/welcome/index' });
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
