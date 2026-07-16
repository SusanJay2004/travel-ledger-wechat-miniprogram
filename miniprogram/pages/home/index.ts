import { ApiError, callApi, type TripSummary } from '../../services/api';
import { getConnectivitySnapshot } from '../../services/connectivity';
import {
  formatCacheTime,
  readHomeTripsCache,
  writeHomeTripsCache,
} from '../../services/local-cache';
import { getLocallyCachedSessionProfile, getSessionProfile } from '../../services/session';

interface HomeData {
  cacheNotice: string;
  errorMessage: string;
  loading: boolean;
  networkNotice: string;
  readOnly: boolean;
  tripGroups: readonly TripGroup[];
}

interface TripGroup {
  year: string;
  trips: readonly TripCard[];
}

interface TripCard extends TripSummary {
  dateText: string;
  totalText: string;
}

interface HomeMethods {
  handleCreateTrip(): void;
  handleOpenTrip(event: WechatMiniprogram.BaseEvent): void;
  handleRetry(): void;
  loadTrips(): Promise<void>;
  showCachedTrips(notice: string): boolean;
}

Page<HomeData, HomeMethods>({
  data: {
    cacheNotice: '',
    errorMessage: '',
    loading: true,
    networkNotice: '',
    readOnly: false,
    tripGroups: [],
  },

  onShow() {
    if (wx.getStorageSync<boolean>('privacy-consent-v1') !== true) return;
    void this.loadTrips();
  },

  async loadTrips() {
    this.setData({ cacheNotice: '', errorMessage: '', loading: true });
    const connectivity = await getConnectivitySnapshot();
    if (connectivity.offline) {
      this.showCachedTrips(connectivity.notice);
      return;
    }
    try {
      const [trips, profile] = await Promise.all([
        callApi<readonly TripSummary[]>('trip.list'),
        getSessionProfile(),
      ]);
      writeHomeTripsCache(profile.userId, trips);
      this.setData({
        loading: false,
        networkNotice: connectivity.notice,
        readOnly: false,
        tripGroups: groupTrips(trips),
      });
    } catch (error: unknown) {
      if (!canUseCacheAfter(error) || !this.showCachedTrips('网络连接失败，仅可查看本机缓存。')) {
        this.setData({ loading: false, errorMessage: toErrorMessage(error) });
      }
    }
  },

  showCachedTrips(notice: string) {
    const profile = getLocallyCachedSessionProfile();
    const cached = profile === null ? null : readHomeTripsCache(profile.userId);
    if (cached === null) {
      this.setData({
        errorMessage: '当前无法联网，且本机还没有可查看的行程缓存。',
        loading: false,
        networkNotice: notice,
        readOnly: true,
      });
      return false;
    }
    this.setData({
      cacheNotice: `显示 ${formatCacheTime(cached.savedAt)} 保存的内容`,
      errorMessage: '',
      loading: false,
      networkNotice: notice,
      readOnly: true,
      tripGroups: groupTrips(cached.value),
    });
    return true;
  },

  handleCreateTrip() {
    if (this.data.readOnly) {
      void wx.showToast({ icon: 'none', title: '离线时不能新建行程' });
      return;
    }
    void wx.navigateTo({ url: '/pages/trip-editor/index' });
  },

  handleOpenTrip(event: WechatMiniprogram.BaseEvent) {
    const tripId = String(event.currentTarget.dataset['tripId'] ?? '');
    if (tripId.length > 0) void wx.navigateTo({ url: `/pages/trip-detail/index?id=${tripId}` });
  },

  handleRetry() {
    void this.loadTrips();
  },
});

function groupTrips(trips: readonly TripSummary[]): readonly TripGroup[] {
  const cards = [...trips]
    .sort((left, right) =>
      (left.startDate ?? '9999-99-99').localeCompare(right.startDate ?? '9999-99-99'),
    )
    .map<TripCard>((trip) => ({
      ...trip,
      dateText:
        trip.startDate === null
          ? '待添加日期'
          : trip.startDate === trip.endDate
            ? formatDate(trip.startDate)
            : `${formatDate(trip.startDate)}-${formatDate(trip.endDate ?? trip.startDate)}`,
      totalText: `¥${(trip.totalCents / 100).toFixed(2)}`,
    }));
  const groups = new Map<string, TripCard[]>();
  for (const card of cards) {
    const year = card.startDate?.slice(0, 4) ?? '待规划';
    const group = groups.get(year) ?? [];
    group.push(card);
    groups.set(year, group);
  }
  return [...groups].map(([year, groupedTrips]) => ({ year, trips: groupedTrips }));
}

function formatDate(value: string): string {
  return value.replaceAll('-', '.');
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '加载失败，请稍后重试。';
}

function canUseCacheAfter(error: unknown): boolean {
  return !(error instanceof ApiError) || error.retryable;
}
