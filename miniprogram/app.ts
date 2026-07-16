import { runtimeConfig } from './config/runtime';

interface TravelLedgerAppOptions {
  runtime: typeof runtimeConfig;
}

App<TravelLedgerAppOptions>({
  runtime: runtimeConfig,
  onLaunch() {
    if (wx.cloud === undefined) {
      console.error('当前微信基础库不支持云开发。');
      return;
    }
    wx.cloud.init({ traceUser: true });
  },
});
