import { runtimeConfig } from '../../config/runtime';
import {
  callApi,
  type AppNotification,
  type FriendView,
  type PublicUserProfile,
} from '../../services/api';

interface MessageData {
  activeTab: 'notifications' | 'friends';
  collaborationEnabled: boolean;
  errorMessage: string;
  friends: readonly FriendView[];
  loading: boolean;
  notifications: readonly AppNotification[];
  publicIdQuery: string;
  searchResult: PublicUserProfile | null;
}

interface MessageMethods {
  handleAddFriend(): Promise<void>;
  handleNotificationAction(event: WechatMiniprogram.BaseEvent): Promise<void>;
  handleQueryInput(event: WechatMiniprogram.Input): void;
  handleSearch(): Promise<void>;
  loadData(): Promise<void>;
  switchTab(event: WechatMiniprogram.BaseEvent): void;
}

Page<MessageData, MessageMethods>({
  data: {
    activeTab: 'notifications',
    collaborationEnabled: runtimeConfig.collaborationEnabled,
    errorMessage: '',
    friends: [],
    loading: runtimeConfig.collaborationEnabled,
    notifications: [],
    publicIdQuery: '',
    searchResult: null,
  },

  onShow() {
    if (this.data.collaborationEnabled) void this.loadData();
  },

  async loadData() {
    this.setData({ errorMessage: '', loading: true });
    try {
      const [notifications, friends] = await Promise.all([
        callApi<readonly AppNotification[]>('social.listNotifications'),
        callApi<readonly FriendView[]>('social.listFriends'),
      ]);
      this.setData({ friends, loading: false, notifications });
    } catch (error: unknown) {
      this.setData({ errorMessage: toMessage(error), loading: false });
    }
  },

  switchTab(event: WechatMiniprogram.BaseEvent) {
    const tab = String(event.currentTarget.dataset['tab'] ?? '');
    if (tab === 'notifications' || tab === 'friends') this.setData({ activeTab: tab });
  },

  handleQueryInput(event: WechatMiniprogram.Input) {
    this.setData({ publicIdQuery: event.detail.value.toUpperCase(), searchResult: null });
  },

  async handleSearch() {
    try {
      const searchResult = await callApi<PublicUserProfile | null>('social.search', {
        publicId: this.data.publicIdQuery,
      });
      this.setData({ searchResult });
      if (searchResult === null) void wx.showToast({ icon: 'none', title: '未找到可添加的用户' });
    } catch (error: unknown) {
      void wx.showToast({ icon: 'none', title: toMessage(error) });
    }
  },

  async handleAddFriend() {
    const result = this.data.searchResult;
    if (result === null) return;
    try {
      await callApi('social.sendFriendRequest', { publicId: result.publicId });
      this.setData({ publicIdQuery: '', searchResult: null });
      void wx.showToast({ icon: 'success', title: '好友申请已发送' });
    } catch (error: unknown) {
      void wx.showToast({ icon: 'none', title: toMessage(error) });
    }
  },

  async handleNotificationAction(event: WechatMiniprogram.BaseEvent) {
    const notificationId = String(event.currentTarget.dataset['notificationId'] ?? '');
    const requestId = String(event.currentTarget.dataset['requestId'] ?? '');
    const invitationId = String(event.currentTarget.dataset['invitationId'] ?? '');
    const accept = event.currentTarget.dataset['accept'] === true;
    try {
      if (requestId.length > 0) {
        await callApi('social.respondFriendRequest', { requestId, accept });
      } else if (invitationId.length > 0) {
        await callApi('social.respondTripInvitation', { invitationId, accept });
      }
      if (notificationId.length > 0) {
        await callApi('social.markNotificationRead', { notificationId });
      }
      await this.loadData();
    } catch (error: unknown) {
      void wx.showToast({ icon: 'none', title: toMessage(error) });
    }
  },
});

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。';
}
