import { runtimeConfig } from '../../config/runtime';
import type { SessionProfile } from '../../services/api';
import { getSessionProfile } from '../../services/session';

interface ProfileData {
  avatarText: string;
  collaborationEnabled: boolean;
  errorMessage: string;
  loading: boolean;
  profile: SessionProfile | null;
}

interface ProfileMethods {
  handleArchivedTrips(): void;
  handleEditProfile(): void;
  handleProfileCode(): void;
  handleSettings(): void;
  loadProfile(): Promise<void>;
}

Page<ProfileData, ProfileMethods>({
  data: {
    avatarText: '旅',
    collaborationEnabled: runtimeConfig.collaborationEnabled,
    errorMessage: '',
    loading: true,
    profile: null,
  },

  onShow() {
    if (wx.getStorageSync<boolean>('privacy-consent-v1') !== true) return;
    void this.loadProfile();
  },

  async loadProfile() {
    this.setData({ errorMessage: '', loading: true });
    try {
      const profile = await getSessionProfile(true);
      this.setData({ avatarText: [...profile.displayName][0] ?? '旅', loading: false, profile });
    } catch (error: unknown) {
      this.setData({
        errorMessage: error instanceof Error ? error.message : '资料加载失败，请稍后重试。',
        loading: false,
      });
    }
  },

  handleArchivedTrips() {
    void wx.navigateTo({ url: '/pages/archived-trips/index' });
  },

  handleEditProfile() {
    void wx.navigateTo({ url: '/pages/profile-editor/index' });
  },

  handleProfileCode() {
    void wx.navigateTo({ url: '/pages/profile-code/index' });
  },

  handleSettings() {
    void wx.navigateTo({ url: '/pages/settings/index' });
  },
});
