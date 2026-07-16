import { callApi, type TripDetail } from '../../services/api';

interface ArchivedCard extends TripDetail {
  dateText: string;
  purgeText: string;
  totalText: string;
}

interface ArchivedData {
  errorMessage: string;
  loading: boolean;
  trips: readonly ArchivedCard[];
}

interface ArchivedMethods {
  handleOpenTrip(event: WechatMiniprogram.BaseEvent): void;
  handleRestore(event: WechatMiniprogram.BaseEvent): Promise<void>;
  loadTrips(): Promise<void>;
}

Page<ArchivedData, ArchivedMethods>({
  data: {
    errorMessage: '',
    loading: true,
    trips: [],
  },

  onShow() {
    void this.loadTrips();
  },

  async loadTrips() {
    try {
      const trips = await callApi<readonly TripDetail[]>('trip.listArchived');
      this.setData({
        loading: false,
        trips: trips.map((trip) => {
          const dates = [...trip.dates].sort();
          const member = trip.members.find((item) => item.viewState === 'archived');
          return {
            ...trip,
            dateText:
              dates.length === 0
                ? '未添加日期'
                : `${dates[0]?.replaceAll('-', '.')} - ${dates.at(-1)?.replaceAll('-', '.')}`,
            purgeText: member === undefined ? '30 天内可恢复' : '30 天内可恢复',
            totalText: `¥${(trip.totalCents / 100).toFixed(2)}`,
          };
        }),
      });
    } catch (error: unknown) {
      this.setData({ errorMessage: toMessage(error), loading: false });
    }
  },

  handleOpenTrip(event: WechatMiniprogram.BaseEvent) {
    const tripId = String(event.currentTarget.dataset['tripId'] ?? '');
    if (tripId.length > 0) void wx.navigateTo({ url: `/pages/trip-detail/index?id=${tripId}` });
  },

  async handleRestore(event: WechatMiniprogram.BaseEvent) {
    const tripId = String(event.currentTarget.dataset['tripId'] ?? '');
    const version = Number(event.currentTarget.dataset['version']);
    try {
      await callApi('trip.restore', { tripId, expectedVersion: version });
      void wx.showToast({ icon: 'success', title: '已恢复到首页' });
      await this.loadTrips();
    } catch (error: unknown) {
      void wx.showToast({ icon: 'none', title: toMessage(error) });
    }
  },
});

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。';
}
