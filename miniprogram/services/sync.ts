import { runtimeConfig } from '../config/runtime';

export interface SyncSubscription {
  close(): Promise<void>;
}

export function watchTripSync(options: {
  userId: string;
  tripId: string;
  onSync: () => void;
  onError: (message: string) => void;
}): SyncSubscription | null {
  if (!runtimeConfig.collaborationEnabled || wx.cloud === undefined) return null;
  const listener = wx.cloud
    .database()
    .collection('sync_events')
    .where({ userId: options.userId, tripId: options.tripId })
    .watch({
      onChange(snapshot) {
        if (snapshot.type !== 'init' && snapshot.docChanges.length > 0) options.onSync();
      },
      onError() {
        options.onError('实时同步暂时断开，重新进入页面会刷新最新内容。');
      },
    });
  return { close: () => listener.close() };
}
