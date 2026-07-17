import { runtimeConfig } from './config/runtime';
import { cloudEnvironmentId } from './config/cloud';
import { isLocalSessionSignedOut } from './services/session';

interface TravelLedgerAppOptions {
  runtime: typeof runtimeConfig;
}

App<TravelLedgerAppOptions>({
  runtime: runtimeConfig,
  onLaunch(options) {
    if (wx.cloud === undefined) {
      console.error('当前微信基础库不支持云开发。');
    } else if (cloudEnvironmentId.length === 0) {
      console.error('尚未生成本机私有小程序环境配置。');
    } else {
      wx.cloud.init({ env: cloudEnvironmentId, traceUser: true });
    }
    guardPrivacyConsent(options);
  },
});

function guardPrivacyConsent(options: WechatMiniprogram.App.LaunchShowOption): void {
  const consented = wx.getStorageSync<boolean>('privacy-consent-v1') === true;
  if (consented && !isLocalSessionSignedOut()) return;
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
