import { callApi, type TripSummary } from '../../services/api';

interface HomeData {
  errorMessage: string;
  loading: boolean;
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
}

Page<HomeData, HomeMethods>({
  data: {
    errorMessage: '',
    loading: true,
    tripGroups: [],
  },

  onShow() {
    if (wx.getStorageSync<boolean>('privacy-consent-v1') !== true) return;
    void this.loadTrips();
  },

  async loadTrips() {
    this.setData({ errorMessage: '', loading: true });
    try {
      const trips = await callApi<readonly TripSummary[]>('trip.list');
      this.setData({ loading: false, tripGroups: groupTrips(trips) });
    } catch (error: unknown) {
      this.setData({ loading: false, errorMessage: toErrorMessage(error) });
    }
  },

  handleCreateTrip() {
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
