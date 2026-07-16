import { callApi } from '../../services/api';

interface TripEditorData {
  errorMessage: string;
  name: string;
  saving: boolean;
}

interface TripEditorMethods {
  handleNameInput(event: WechatMiniprogram.Input): void;
  handleSubmit(): Promise<void>;
}

Page<TripEditorData, TripEditorMethods>({
  data: {
    errorMessage: '',
    name: '',
    saving: false,
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
      const result = await callApi<{ tripId: string }>('trip.create', { name });
      void wx.redirectTo({ url: `/pages/trip-detail/index?id=${result.tripId}` });
    } catch (error: unknown) {
      this.setData({
        errorMessage: error instanceof Error ? error.message : '创建失败，请稍后重试。',
        saving: false,
      });
    }
  },
});
