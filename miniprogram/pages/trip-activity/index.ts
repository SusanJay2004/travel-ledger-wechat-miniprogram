import { callApi, type TripActivity, type TripDetail } from '../../services/api';
import { isVersionConflict, showVersionConflictAndRefresh } from '../../services/conflict';
import { isDeletedBillRestorable } from '../../services/bill-retention';

interface ActivityItem extends TripActivity {
  actorName: string;
  actionText: string;
  canRestoreBill: boolean;
  timeText: string;
}

interface ActivityData {
  activities: readonly ActivityItem[];
  errorMessage: string;
  loading: boolean;
  trip: TripDetail | null;
  tripId: string;
}

interface ActivityMethods {
  handleRestoreBill(event: WechatMiniprogram.BaseEvent): Promise<void>;
  loadActivity(): Promise<void>;
}

Page<ActivityData, ActivityMethods>({
  data: { activities: [], errorMessage: '', loading: true, trip: null, tripId: '' },

  onLoad(query: Record<string, string | undefined>) {
    this.setData({ tripId: query['id'] ?? '' });
    void this.loadActivity();
  },

  async loadActivity() {
    if (this.data.tripId.length === 0) {
      this.setData({ errorMessage: '缺少行程 ID。', loading: false });
      return;
    }
    try {
      const [trip, activities] = await Promise.all([
        callApi<TripDetail>('trip.get', { tripId: this.data.tripId }),
        callApi<readonly TripActivity[]>('trip.activity', { tripId: this.data.tripId }),
      ]);
      const nameById = Object.fromEntries(
        trip.members.map((member) => [member.userId, member.displayNameSnapshot]),
      );
      this.setData({
        activities: activities.map((activity) => ({
          ...activity,
          actorName: nameById[activity.actorUserId] ?? '同行人',
          actionText: actionText(activity.action),
          canRestoreBill:
            trip.status === 'active' &&
            activity.action === 'bill.deleted' &&
            trip.bills.some(
              (bill) => bill.id === activity.entityId && isDeletedBillRestorable(bill.deletedAt),
            ),
          timeText: formatTime(activity.createdAt),
        })),
        loading: false,
        trip,
      });
    } catch (error: unknown) {
      this.setData({ errorMessage: toMessage(error), loading: false });
    }
  },

  async handleRestoreBill(event: WechatMiniprogram.BaseEvent) {
    const trip = this.data.trip;
    const billId = String(event.currentTarget.dataset['billId'] ?? '');
    if (trip === null || billId.length === 0) return;
    const confirmed = await wx.showModal({
      title: '恢复这笔账单？',
      content: '恢复后会重新计入总支出和分账，并同步给所有同行人。',
      confirmColor: '#0F6E65',
    });
    if (!confirmed.confirm) return;
    try {
      await callApi('trip.restoreBill', {
        tripId: trip.id,
        billId,
        expectedVersion: trip.version,
      });
      await this.loadActivity();
      void wx.showToast({ icon: 'success', title: '账单已恢复' });
    } catch (error: unknown) {
      if (isVersionConflict(error)) {
        await showVersionConflictAndRefresh(() => this.loadActivity());
        return;
      }
      void wx.showToast({ icon: 'none', title: toMessage(error) });
    }
  },
});

function actionText(action: string): string {
  const labels: Record<string, string> = {
    'trip.created': '创建了行程',
    'trip.renamed': '修改了行程名称',
    'date.created': '添加了日期',
    'date.deleted': '删除了日期',
    'bill.created': '添加了账单',
    'bill.updated': '修改了账单',
    'bill.deleted': '删除了账单',
    'bill.restored': '恢复了账单',
    'trip.completed': '完结了行程',
    'trip.reopened': '重新开启了行程',
    'member.joined': '加入了行程',
    'member.left': '退出了行程',
    'member.archived': '归档了自己的行程',
    'member.restored': '恢复了自己的行程',
    'member.detached': '永久移除了自己的行程',
  };
  return labels[action] ?? '更新了行程';
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : '活动记录加载失败。';
}
