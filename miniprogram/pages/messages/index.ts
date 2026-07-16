import { runtimeConfig } from '../../config/runtime';
import {
  callApi,
  type AppNotification,
  type BlockedUserView,
  type FriendView,
  type PublicUserProfile,
} from '../../services/api';
import { getSessionProfile } from '../../services/session';

interface MessageData {
  activeTab: 'notifications' | 'friends';
  collaborationEnabled: boolean;
  errorMessage: string;
  friends: readonly FriendView[];
  blockedUsers: readonly BlockedUserView[];
  loading: boolean;
  notifications: readonly AppNotification[];
  unreadCount: number;
  publicIdQuery: string;
  searchResult: PublicUserProfile | null;
}

interface MessageMethods {
  handleAddFriend(): Promise<void>;
  handleNotificationAction(event: WechatMiniprogram.BaseEvent): Promise<void>;
  handleNotificationRead(event: WechatMiniprogram.BaseEvent): Promise<void>;
  handleFriendManage(event: WechatMiniprogram.BaseEvent): Promise<void>;
  handleUnblock(event: WechatMiniprogram.BaseEvent): Promise<void>;
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
    blockedUsers: [],
    loading: runtimeConfig.collaborationEnabled,
    notifications: [],
    unreadCount: 0,
    publicIdQuery: '',
    searchResult: null,
  },

  onLoad(query: Record<string, string | undefined>) {
    const publicId = scenePublicId(query['scene']) ?? query['publicId'] ?? '';
    if (/^[A-Z2-9]{10}$/.test(publicId)) {
      this.setData({ activeTab: 'friends', publicIdQuery: publicId });
      if (this.data.collaborationEnabled) void this.handleSearch();
    }
  },

  onShow() {
    if (wx.getStorageSync<boolean>('privacy-consent-v1') !== true) return;
    void getSessionProfile()
      .then((profile) => {
        const collaborationEnabled = profile.productMode === 'collaboration';
        this.setData({ collaborationEnabled });
        if (collaborationEnabled) {
          void this.loadData();
          if (/^[A-Z2-9]{10}$/.test(this.data.publicIdQuery) && this.data.searchResult === null) {
            void this.handleSearch();
          }
        }
      })
      .catch((error: unknown) => {
        this.setData({ errorMessage: toMessage(error), loading: false });
      });
  },

  async loadData() {
    this.setData({ errorMessage: '', loading: true });
    try {
      const [notifications, friends, blockedUsers] = await Promise.all([
        callApi<readonly AppNotification[]>('social.listNotifications'),
        callApi<readonly FriendView[]>('social.listFriends'),
        callApi<readonly BlockedUserView[]>('social.listBlocked'),
      ]);
      const unreadCount = notifications.filter((item) => item.readAt === null).length;
      this.setData({ blockedUsers, friends, loading: false, notifications, unreadCount });
      if (unreadCount > 0) {
        void wx.setTabBarBadge({ index: 1, text: unreadCount > 99 ? '99+' : String(unreadCount) });
      } else {
        void wx.removeTabBarBadge({ index: 1 });
      }
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

  async handleNotificationRead(event: WechatMiniprogram.BaseEvent) {
    const notificationId = String(event.currentTarget.dataset['notificationId'] ?? '');
    const unread = event.currentTarget.dataset['unread'] === true;
    if (!unread || notificationId.length === 0) return;
    try {
      await callApi('social.markNotificationRead', { notificationId });
      await this.loadData();
    } catch (error: unknown) {
      void wx.showToast({ icon: 'none', title: toMessage(error) });
    }
  },

  async handleFriendManage(event: WechatMiniprogram.BaseEvent) {
    const friendUserId = String(event.currentTarget.dataset['userId'] ?? '');
    const displayName = String(event.currentTarget.dataset['displayName'] ?? '这位好友');
    if (friendUserId.length === 0) return;
    try {
      const selected = await wx.showActionSheet({ itemList: ['删除好友', '加入黑名单'] });
      const blocking = selected.tapIndex === 1;
      const result = await wx.showModal({
        title: blocking ? `拉黑${displayName}？` : `删除${displayName}？`,
        content: blocking
          ? '将同时解除好友关系，对方无法搜索或邀请你；可在本页解除。'
          : '共同参与的已有行程不会受到影响。',
        confirmText: blocking ? '确认拉黑' : '确认删除',
        confirmColor: '#A53838',
      });
      if (!result.confirm) return;
      await callApi(blocking ? 'social.blockUser' : 'social.deleteFriend', {
        [blocking ? 'blockedUserId' : 'friendUserId']: friendUserId,
      });
      await this.loadData();
    } catch (error: unknown) {
      if (isCancelled(error)) return;
      void wx.showToast({ icon: 'none', title: toMessage(error) });
    }
  },

  async handleUnblock(event: WechatMiniprogram.BaseEvent) {
    const blockedUserId = String(event.currentTarget.dataset['userId'] ?? '');
    if (blockedUserId.length === 0) return;
    try {
      await callApi('social.unblockUser', { blockedUserId });
      await this.loadData();
    } catch (error: unknown) {
      void wx.showToast({ icon: 'none', title: toMessage(error) });
    }
  },
});

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。';
}

function isCancelled(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if (!('errMsg' in error) || typeof error.errMsg !== 'string') return false;
  return error.errMsg.includes('cancel');
}

function scenePublicId(scene: string | undefined): string | null {
  if (scene === undefined) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(scene);
  } catch {
    return null;
  }
  const match = /(?:^|&)u=([A-Z2-9]{10})(?:&|$)/.exec(decoded);
  return match?.[1] ?? null;
}
