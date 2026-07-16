import { ApiError, callApi, type TripDetail } from '../../services/api';

interface TripEditorData {
  editable: boolean;
  errorMessage: string;
  name: string;
  saving: boolean;
  tripId: string;
  version: number;
}

interface TripEditorMethods {
  handleNameInput(event: WechatMiniprogram.Input): void;
  handleSubmit(): Promise<void>;
  handleVersionConflict(draftName: string): Promise<void>;
  loadTrip(): Promise<void>;
}

Page<TripEditorData, TripEditorMethods>({
  data: {
    editable: true,
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
      this.setData({
        editable: trip.status === 'active',
        errorMessage: trip.status === 'completed' ? '行程已完结，名称暂时不能修改。' : '',
        name: trip.name,
        version: trip.version,
      });
    } catch (error: unknown) {
      this.setData({ errorMessage: toMessage(error) });
    }
  },

  handleNameInput(event: WechatMiniprogram.Input) {
    if (!this.data.editable) return;
    this.setData({ name: event.detail.value, errorMessage: '' });
  },

  async handleSubmit() {
    if (this.data.saving || !this.data.editable) return;
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
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        await this.handleVersionConflict(name);
        return;
      }
      this.setData({
        errorMessage: error instanceof Error ? error.message : '创建失败，请稍后重试。',
        saving: false,
      });
    }
  },

  async handleVersionConflict(draftName: string) {
    try {
      const latest = await callApi<TripDetail>('trip.get', { tripId: this.data.tripId });
      await wx.showModal({
        title: latest.status === 'completed' ? '行程已完结' : '行程刚刚被修改',
        content:
          latest.status === 'completed'
            ? `最新名称：${latest.name}\n你输入的名称：${draftName}\n\n已保留你的输入，但行程现在为只读。`
            : `最新名称：${latest.name}\n你输入的名称：${draftName}\n\n已保留你的输入，请核对后再次保存。`,
        showCancel: false,
        confirmText: latest.status === 'completed' ? '查看最新状态' : '查看并重试',
        confirmColor: '#0F6E65',
      });
      this.setData({
        editable: latest.status === 'active',
        errorMessage:
          latest.status === 'completed'
            ? '同行人已完结行程，名称暂时不能修改。'
            : '已加载最新版本，确认名称后请再次点击保存。',
        name: draftName,
        saving: false,
        version: latest.version,
      });
    } catch (refreshError: unknown) {
      this.setData({ errorMessage: toMessage(refreshError), saving: false });
    }
  },
});

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。';
}
