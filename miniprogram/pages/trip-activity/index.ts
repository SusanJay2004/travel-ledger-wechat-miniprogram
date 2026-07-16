import { callApi, type TripActivity, type TripDetail } from '../../services/api';

interface ActivityItem extends TripActivity {
  actorName: string;
  actionText: string;
  timeText: string;
}

interface ActivityData {
  activities: readonly ActivityItem[];
  errorMessage: string;
  loading: boolean;
  tripId: string;
}

interface ActivityMethods {
  loadActivity(): Promise<void>;
}

Page<ActivityData, ActivityMethods>({
  data: { activities: [], errorMessage: '', loading: true, tripId: '' },

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
          timeText: formatTime(activity.createdAt),
        })),
        loading: false,
      });
    } catch (error: unknown) {
      this.setData({ errorMessage: toMessage(error), loading: false });
    }
  },
});

function actionText(action: string): string {
  const labels: Record<string, string> = {
    'trip.created': '创建了行程',
    'trip.renamed': '修改了行程名称',
    'date.created': '添加了日期',
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
