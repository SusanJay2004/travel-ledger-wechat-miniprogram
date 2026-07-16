import { callApi, type SessionProfile } from '../../services/api';

interface ProfileData {
  errorMessage: string;
  loading: boolean;
  profile: SessionProfile | null;
}

interface ProfileMethods {
  handleArchivedTrips(): void;
  loadProfile(): Promise<void>;
}

Page<ProfileData, ProfileMethods>({
  data: {
    errorMessage: '',
    loading: true,
    profile: null,
  },

  onShow() {
    void this.loadProfile();
  },

  async loadProfile() {
    this.setData({ errorMessage: '', loading: true });
    try {
      const profile = await callApi<SessionProfile>('session.bootstrap');
      this.setData({ loading: false, profile });
    } catch (error: unknown) {
      this.setData({
        errorMessage: error instanceof Error ? error.message : '资料加载失败，请稍后重试。',
        loading: false,
      });
    }
  },

  handleArchivedTrips() {
    void wx.showToast({ icon: 'none', title: '已完结行程功能正在建设' });
  },
});
