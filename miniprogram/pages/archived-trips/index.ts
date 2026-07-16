import { callApi, type TripDetail } from '../../services/api';
import { isVersionConflict, showVersionConflictAndRefresh } from '../../services/conflict';
import { getSessionProfile } from '../../services/session';

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
  handleClear(): Promise<void>;
  handleRemove(event: WechatMiniprogram.BaseEvent): Promise<void>;
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
      const [trips, profile] = await Promise.all([
        callApi<readonly TripDetail[]>('trip.listArchived'),
        getSessionProfile(),
      ]);
      this.setData({
        loading: false,
        trips: trips.map((trip) => {
          const dates = [...trip.dates].sort();
          const member = trip.members.find((item) => item.userId === profile.userId);
          return {
            ...trip,
            dateText:
              dates.length === 0
                ? '未添加日期'
                : `${dates[0]?.replaceAll('-', '.')} - ${dates.at(-1)?.replaceAll('-', '.')}`,
            purgeText: remainingText(member?.purgeAfter ?? null),
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
      if (isVersionConflict(error)) {
        await showVersionConflictAndRefresh(() => this.loadTrips());
        return;
      }
      void wx.showToast({ icon: 'none', title: toMessage(error) });
    }
  },

  async handleRemove(event: WechatMiniprogram.BaseEvent) {
    const tripId = String(event.currentTarget.dataset['tripId'] ?? '');
    const version = Number(event.currentTarget.dataset['version']);
    const result = await wx.showModal({
      title: '永久移除这段行程？',
      content: '移除后你无法恢复，但不会影响其他同行人。',
      confirmText: '永久移除',
      confirmColor: '#A53838',
    });
    if (!result.confirm) return;
    try {
      await callApi('trip.removeArchived', { tripId, expectedVersion: version });
      await this.loadTrips();
    } catch (error: unknown) {
      if (isVersionConflict(error)) {
        await showVersionConflictAndRefresh(() => this.loadTrips());
        return;
      }
      void wx.showToast({ icon: 'none', title: toMessage(error) });
    }
  },

  async handleClear() {
    if (this.data.trips.length === 0) return;
    const result = await wx.showModal({
      title: '清空已完结行程？',
      content: `将永久移除当前 ${this.data.trips.length} 段行程，且无法恢复。`,
      confirmText: '确认清空',
      confirmColor: '#A53838',
    });
    if (!result.confirm) return;
    try {
      for (const trip of this.data.trips) {
        await callApi('trip.removeArchived', {
          tripId: trip.id,
          expectedVersion: trip.version,
        });
      }
      await this.loadTrips();
    } catch (error: unknown) {
      if (isVersionConflict(error)) {
        await showVersionConflictAndRefresh(() => this.loadTrips());
        return;
      }
      void wx.showToast({ icon: 'none', title: toMessage(error) });
      await this.loadTrips();
    }
  },
});

function remainingText(purgeAfter: string | null): string {
  if (purgeAfter === null) return '恢复期限未知';
  const remainingMs = new Date(purgeAfter).getTime() - Date.now();
  const days = Math.max(0, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));
  return days === 0 ? '今天到期' : `还可恢复 ${days} 天`;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。';
}
