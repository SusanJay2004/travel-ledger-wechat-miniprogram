import { callApi } from '../../services/api';
import { signOutLocalSession } from '../../services/session';

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
      confirmColor: '#0F6E65',
    });
    if (!result.confirm) return;
    this.setData({ signingOut: true });
    const localDataCleared = signOutLocalSession();
    if (!localDataCleared) {
      await wx.showModal({
        title: '已停止登录',
        content: '部分本机缓存无法确认清除。请在微信设置中清理本小程序存储后再交给他人使用。',
        showCancel: false,
      });
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
      confirmColor: '#A53838',
    });
    if (!first.confirm) return;
    const final = await wx.showModal({
      title: '最后确认',
      content: '注销后再次进入会创建全新账号，无法找回旧行程。确认永久注销吗？',
      confirmText: '永久注销',
      confirmColor: '#A53838',
    });
    if (!final.confirm) return;
    this.setData({ deleting: true });
    try {
      await callApi('session.deleteAccount');
    } catch (error: unknown) {
      this.setData({ deleting: false });
      void wx.showModal({ title: '注销未完成', content: toMessage(error), showCancel: false });
      return;
    }

    const localDataCleared = signOutLocalSession();
    if (!localDataCleared) {
      await wx.showModal({
        title: '账号已注销',
        content:
          '云端账号已永久注销，但部分本机缓存无法确认清除。请在微信设置中清理本小程序存储后再交给他人使用。',
        showCancel: false,
      });
    }
    void wx.removeTabBarBadge({ index: 1 }).catch(() => undefined);
    void wx.reLaunch({ url: '/pages/welcome/index' });
  },
});

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请稍后重试，期间不要继续修改行程。';
}
