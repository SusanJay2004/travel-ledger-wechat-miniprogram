import { runtimeConfig } from './config/runtime';

interface TravelLedgerAppOptions {
  runtime: typeof runtimeConfig;
}

App<TravelLedgerAppOptions>({
  runtime: runtimeConfig,
  onLaunch(options) {
    if (wx.cloud === undefined) {
      console.error('当前微信基础库不支持云开发。');
      return;
    }
    wx.cloud.init({ traceUser: true });
    guardPrivacyConsent(options);
  },
});

function guardPrivacyConsent(options: WechatMiniprogram.App.LaunchShowOption): void {
  if (wx.getStorageSync<boolean>('privacy-consent-v1') === true) return;
  if (options.path === 'pages/welcome/index' || options.path === 'pages/legal/index') return;
  if (options.path === 'pages/messages/index' && typeof options.query['scene'] === 'string') {
    wx.setStorageSync('pending-launch-v1', {
      path: options.path,
      scene: options.query['scene'],
    });
  }
  setTimeout(() => {
    void wx.reLaunch({ url: '/pages/welcome/index' });
  }, 0);
}
