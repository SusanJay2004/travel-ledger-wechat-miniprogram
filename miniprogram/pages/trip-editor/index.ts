import { callApi, type TripDetail } from '../../services/api';

interface TripEditorData {
  errorMessage: string;
  name: string;
  saving: boolean;
  tripId: string;
  version: number;
}

interface TripEditorMethods {
  handleNameInput(event: WechatMiniprogram.Input): void;
  handleSubmit(): Promise<void>;
  loadTrip(): Promise<void>;
}

Page<TripEditorData, TripEditorMethods>({
  data: {
    errorMessage: '',
    name: '',
    saving: false,
    tripId: '',
    version: 0,
  },

  onLoad(query: Record<string, string | undefined>) {
    const tripId = query['id'] ?? '';
    const version = Number(query['version'] ?? 0);
    this.setData({ tripId, version: Number.isSafeInteger(version) ? version : 0 });
    if (tripId.length > 0) {
      void wx.setNavigationBarTitle({ title: '修改行程名称' });
      void this.loadTrip();
    }
  },

  async loadTrip() {
    try {
      const trip = await callApi<TripDetail>('trip.get', { tripId: this.data.tripId });
      this.setData({ name: trip.name, version: trip.version });
    } catch (error: unknown) {
      this.setData({ errorMessage: toMessage(error) });
    }
  },

  handleNameInput(event: WechatMiniprogram.Input) {
    this.setData({ name: event.detail.value, errorMessage: '' });
  },

  async handleSubmit() {
    const name = this.data.name.trim();
    if (!/^[\u3400-\u9fffA-Za-z0-9]+(?: [\u3400-\u9fffA-Za-z0-9]+)*$/.test(name)) {
      this.setData({ errorMessage: '请输入 1–20 个中文、英文字母、数字或内部空格。' });
      return;
    }
    if ([...name].length > 20) {
      this.setData({ errorMessage: '行程名称不能超过 20 个字符。' });
      return;
    }

    this.setData({ saving: true });
    try {
      if (this.data.tripId.length > 0) {
        await callApi('trip.rename', {
          tripId: this.data.tripId,
          name,
          expectedVersion: this.data.version,
        });
        void wx.navigateBack();
      } else {
        const result = await callApi<{ tripId: string }>('trip.create', { name });
        void wx.redirectTo({ url: `/pages/trip-detail/index?id=${result.tripId}` });
      }
    } catch (error: unknown) {
      this.setData({
        errorMessage: error instanceof Error ? error.message : '创建失败，请稍后重试。',
        saving: false,
      });
    }
  },
});

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。';
}
