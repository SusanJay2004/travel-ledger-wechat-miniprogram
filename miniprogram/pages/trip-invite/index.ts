import { callApi, type FriendView, type TripDetail } from '../../services/api';

interface SelectableFriend extends FriendView {
  visible: boolean;
  selected: boolean;
}

interface InviteData {
  errorMessage: string;
  friends: readonly SelectableFriend[];
  loading: boolean;
  query: string;
  saving: boolean;
  tripId: string;
}

interface InviteMethods {
  handleQueryInput(event: WechatMiniprogram.Input): void;
  handleSubmit(): Promise<void>;
  loadFriends(): Promise<void>;
  toggleFriend(event: WechatMiniprogram.BaseEvent): void;
}

Page<InviteData, InviteMethods>({
  data: {
    errorMessage: '',
    friends: [],
    loading: true,
    query: '',
    saving: false,
    tripId: '',
  },

  onLoad(query: Record<string, string | undefined>) {
    this.setData({ tripId: query['tripId'] ?? '' });
    void this.loadFriends();
  },

  async loadFriends() {
    try {
      const [friends, trip] = await Promise.all([
        callApi<readonly FriendView[]>('social.listFriends'),
        callApi<TripDetail>('trip.get', { tripId: this.data.tripId }),
      ]);
      const existing = new Set(trip.members.map((member) => member.userId));
      this.setData({
        friends: friends
          .filter((friend) => !existing.has(friend.userId))
          .map((friend) => ({ ...friend, selected: false, visible: true })),
        loading: false,
      });
    } catch (error: unknown) {
      this.setData({ errorMessage: toMessage(error), loading: false });
    }
  },

  handleQueryInput(event: WechatMiniprogram.Input) {
    const query = event.detail.value.trim().toUpperCase();
    this.setData({
      friends: this.data.friends.map((friend) => ({
        ...friend,
        visible:
          query.length === 0 ||
          friend.displayName.toUpperCase().includes(query) ||
          friend.publicId.includes(query),
      })),
      query: event.detail.value,
    });
  },

  toggleFriend(event: WechatMiniprogram.BaseEvent) {
    const userId = String(event.currentTarget.dataset['userId'] ?? '');
    this.setData({
      friends: this.data.friends.map((friend) =>
        friend.userId === userId ? { ...friend, selected: !friend.selected } : friend,
      ),
    });
  },

  async handleSubmit() {
    const selected = this.data.friends.filter((friend) => friend.selected);
    if (selected.length === 0 || this.data.saving) return;
    this.setData({ saving: true });
    try {
      for (const friend of selected) {
        await callApi('social.inviteToTrip', {
          tripId: this.data.tripId,
          inviteeUserId: friend.userId,
        });
      }
      void wx.showToast({ icon: 'success', title: `已邀请 ${selected.length} 人` });
      void wx.navigateBack();
    } catch (error: unknown) {
      this.setData({ errorMessage: toMessage(error), saving: false });
    }
  },
});

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : '邀请失败，请稍后重试。';
}
