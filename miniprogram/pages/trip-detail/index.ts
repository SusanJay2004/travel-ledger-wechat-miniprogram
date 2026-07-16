import {
  ApiError,
  callApi,
  type SettlementResponse,
  type TripBill,
  type TripDetail,
} from '../../services/api';
import { runtimeConfig } from '../../config/runtime';
import { watchTripSync, type SyncSubscription } from '../../services/sync';
import { getSessionProfile } from '../../services/session';

interface BillCard extends TripBill {
  amountText: string;
  invalid: boolean;
  participantText: string;
  payerText: string;
}

interface DateSection {
  date: string;
  dateText: string;
  bills: readonly BillCard[];
}

interface DetailData {
  addingDate: boolean;
  collaborationEnabled: boolean;
  dateSections: readonly DateSection[];
  deletedBills: readonly BillCard[];
  errorMessage: string;
  loading: boolean;
  selectedDate: string;
  trip: TripDetail | null;
  totalText: string;
}

interface DetailMethods {
  closeSync(): Promise<void>;
  handleAddBill(event: WechatMiniprogram.BaseEvent): void;
  handleArchive(): Promise<void>;
  handleBillAction(event: WechatMiniprogram.BaseEvent): Promise<void>;
  handleComplete(): Promise<void>;
  handleDateChange(event: WechatMiniprogram.PickerChange): void;
  handleInvite(): void;
  handleActivity(): void;
  handleRename(): void;
  handleReopen(): Promise<void>;
  handleLeave(): Promise<void>;
  handleRetry(): void;
  handleRestoreBill(event: WechatMiniprogram.BaseEvent): Promise<void>;
  handleSettle(): Promise<void>;
  loadTrip(): Promise<void>;
  submitDate(): Promise<void>;
  startSync(trip: TripDetail, currentUserId: string): void;
  syncDebounce: number | null;
  syncSubscription: SyncSubscription | null;
}

Page<DetailData, DetailMethods>({
  syncSubscription: null as SyncSubscription | null,
  syncDebounce: null as number | null,
  data: {
    addingDate: false,
    collaborationEnabled: runtimeConfig.collaborationEnabled,
    dateSections: [],
    deletedBills: [],
    errorMessage: '',
    loading: true,
    selectedDate: today(),
    trip: null,
    totalText: '¥0.00',
  },

  onLoad(query: Record<string, string | undefined>) {
    const tripId = query['id'] ?? '';
    this.setData({ trip: tripId.length > 0 ? ({ id: tripId } as TripDetail) : null });
  },

  onShow() {
    void this.loadTrip();
  },

  onHide() {
    void this.closeSync();
  },

  onUnload() {
    void this.closeSync();
  },

  async loadTrip() {
    const tripId = this.data.trip?.id;
    if (tripId === undefined) {
      this.setData({ errorMessage: '缺少行程 ID。', loading: false });
      return;
    }
    this.setData({ errorMessage: '', loading: true });
    try {
      const [trip, profile] = await Promise.all([
        callApi<TripDetail>('trip.get', { tripId }),
        getSessionProfile(),
      ]);
      void wx.setNavigationBarTitle({ title: trip.name });
      this.setData({
        collaborationEnabled: profile.productMode === 'collaboration',
        dateSections: buildDateSections(trip),
        deletedBills: trip.bills.filter((bill) => bill.deletedAt !== null).map(toBillCard),
        loading: false,
        trip,
        totalText: formatCents(trip.totalCents),
      });
      this.startSync(trip, profile.userId);
    } catch (error: unknown) {
      this.setData({ errorMessage: toMessage(error), loading: false });
    }
  },

  handleDateChange(event: WechatMiniprogram.PickerChange) {
    this.setData({ selectedDate: String(event.detail.value) });
    void this.submitDate();
  },

  async submitDate() {
    const trip = this.data.trip;
    if (trip === null || this.data.addingDate) return;
    this.setData({ addingDate: true });
    try {
      await callApi<TripDetail>('trip.addDate', {
        tripId: trip.id,
        date: this.data.selectedDate,
        expectedVersion: trip.version,
      });
      this.setData({ addingDate: false });
      await this.loadTrip();
    } catch (error: unknown) {
      this.setData({ addingDate: false });
      void wx.showToast({ icon: 'none', title: toMessage(error) });
    }
  },

  handleAddBill(event: WechatMiniprogram.BaseEvent) {
    const trip = this.data.trip;
    const date = String(event.currentTarget.dataset['date'] ?? '');
    if (trip !== null && date.length > 0) {
      void wx.navigateTo({
        url: `/pages/bill-editor/index?tripId=${trip.id}&date=${date}&version=${trip.version}`,
      });
    }
  },

  handleInvite() {
    const trip = this.data.trip;
    if (trip !== null) void wx.navigateTo({ url: `/pages/trip-invite/index?tripId=${trip.id}` });
  },

  handleRename() {
    const trip = this.data.trip;
    if (trip !== null && trip.status === 'active') {
      void wx.navigateTo({
        url: `/pages/trip-editor/index?id=${trip.id}&version=${trip.version}`,
      });
    }
  },

  handleActivity() {
    const trip = this.data.trip;
    if (trip !== null) {
      void wx.navigateTo({ url: `/pages/trip-activity/index?id=${trip.id}` });
    }
  },

  async handleReopen() {
    const trip = this.data.trip;
    if (trip === null || trip.status !== 'completed') return;
    if (!(await confirm('重新开启行程？', '重新开启后所有同行人都可以继续修改账本。'))) return;
    try {
      await callApi('trip.reopen', { tripId: trip.id, expectedVersion: trip.version });
      await this.loadTrip();
    } catch (error: unknown) {
      void wx.showToast({ icon: 'none', title: toMessage(error) });
    }
  },

  async handleLeave() {
    const trip = this.data.trip;
    if (trip === null) return;
    const accepted = await confirm(
      '退出这段行程？',
      '未被账单引用时可以退出，退出后将不再看到该行程。',
    );
    if (!accepted) return;
    try {
      await callApi('social.leaveTrip', { tripId: trip.id });
      void wx.switchTab({ url: '/pages/home/index' });
    } catch (error: unknown) {
      void wx.showToast({ icon: 'none', title: toMessage(error) });
    }
  },

  async handleBillAction(event: WechatMiniprogram.BaseEvent) {
    const trip = this.data.trip;
    const billId = String(event.currentTarget.dataset['billId'] ?? '');
    if (trip === null || trip.status !== 'active' || billId.length === 0) return;
    const selected = await wx.showActionSheet({ itemList: ['修改账单', '删除账单'] });
    if (selected.tapIndex === 0) {
      const bill = trip.bills.find((item) => item.id === billId);
      if (bill !== undefined) {
        void wx.navigateTo({
          url: `/pages/bill-editor/index?tripId=${trip.id}&date=${bill.date}&version=${trip.version}&billId=${bill.id}`,
        });
      }
      return;
    }
    const confirmed = await confirm('删除这笔账单？', '删除后 30 天内可以从本页底部恢复。');
    if (!confirmed) return;
    try {
      await callApi('trip.deleteBill', {
        tripId: trip.id,
        billId,
        expectedVersion: trip.version,
      });
      await this.loadTrip();
    } catch (error: unknown) {
      void wx.showToast({ icon: 'none', title: toMessage(error) });
    }
  },

  async handleRestoreBill(event: WechatMiniprogram.BaseEvent) {
    const trip = this.data.trip;
    const billId = String(event.currentTarget.dataset['billId'] ?? '');
    if (trip === null || billId.length === 0) return;
    try {
      await callApi('trip.restoreBill', {
        tripId: trip.id,
        billId,
        expectedVersion: trip.version,
      });
      await this.loadTrip();
    } catch (error: unknown) {
      void wx.showToast({ icon: 'none', title: toMessage(error) });
    }
  },

  async handleSettle() {
    const trip = this.data.trip;
    if (trip === null) return;
    const firstInvalid = trip.bills.find(
      (bill) => bill.deletedAt === null && bill.validationCodes.length > 0,
    );
    if (firstInvalid !== undefined) {
      const decision = await wx.showModal({
        title: `${trip.invalidBillCount} 笔账单待完善`,
        content: '待完善账单不会参与分账。你可以立即修改第一笔，或忽略它们后继续计算。',
        cancelText: '去修改',
        confirmText: '忽略并计算',
        confirmColor: '#167D73',
      });
      if (!decision.confirm) {
        void wx.navigateTo({
          url: `/pages/bill-editor/index?tripId=${trip.id}&date=${firstInvalid.date}&version=${trip.version}&billId=${firstInvalid.id}`,
        });
        return;
      }
    }
    try {
      const settlement = await callApi<SettlementResponse>('trip.calculate', { tripId: trip.id });
      const nameById = Object.fromEntries(
        trip.members.map((member) => [member.userId, member.displayNameSnapshot]),
      );
      const lines = settlement.result.transfers.map(
        (transfer) =>
          `${nameById[transfer.fromMemberId] ?? '成员'} 给 ${nameById[transfer.toMemberId] ?? '成员'} ${formatCents(transfer.amountCents)}`,
      );
      const summary = [
        ...(lines.length > 0 ? lines : ['大家已经结清，无需转账。']),
        '',
        `纳入 ${formatCents(settlement.includedCents)}`,
        settlement.ignoredBillIds.length > 0
          ? `已忽略 ${settlement.ignoredBillIds.length} 笔待完善账单`
          : '没有忽略账单',
      ].join('\n');
      void wx.showModal({ title: '最简分账方案', content: summary, showCancel: false });
    } catch (error: unknown) {
      void wx.showToast({ icon: 'none', title: toMessage(error) });
    }
  },

  async handleComplete() {
    const trip = this.data.trip;
    if (trip === null) return;
    const confirmed = await confirm(
      '完结这段行程？',
      '完结后账本会变为只读，仍可重新开启。建议先检查并计算分账。',
    );
    if (!confirmed) return;
    try {
      await callApi<TripDetail>('trip.complete', {
        tripId: trip.id,
        expectedVersion: trip.version,
        ignoreInvalidBills: false,
      });
      await this.loadTrip();
    } catch (error: unknown) {
      if (error instanceof ApiError && error.code === 'INVALID_BILLS_REQUIRE_CONFIRMATION') {
        const ignore = await confirm('仍有待完善账单', '这些账单不会参与结算。确认忽略并完结吗？');
        if (ignore) {
          await callApi<TripDetail>('trip.complete', {
            tripId: trip.id,
            expectedVersion: trip.version,
            ignoreInvalidBills: true,
          });
          await this.loadTrip();
        }
        return;
      }
      void wx.showToast({ icon: 'none', title: toMessage(error) });
    }
  },

  async handleArchive() {
    const trip = this.data.trip;
    if (trip === null) return;
    const confirmed = await confirm(
      '移入已完结行程？',
      '30 天内可以从“我的”恢复，不影响其他同行人。',
    );
    if (!confirmed) return;
    try {
      await callApi('trip.archive', { tripId: trip.id, expectedVersion: trip.version });
      void wx.switchTab({ url: '/pages/home/index' });
    } catch (error: unknown) {
      void wx.showToast({ icon: 'none', title: toMessage(error) });
    }
  },

  handleRetry() {
    void this.loadTrip();
  },

  startSync(trip: TripDetail, currentUserId: string) {
    if (this.syncSubscription !== null) return;
    if (!trip.members.some((member) => member.userId === currentUserId)) return;
    this.syncSubscription = watchTripSync({
      userId: currentUserId,
      tripId: trip.id,
      onSync: () => {
        if (this.syncDebounce !== null) clearTimeout(this.syncDebounce);
        this.syncDebounce = setTimeout(() => {
          this.syncDebounce = null;
          void this.loadTrip();
        }, 250);
      },
      onError: (message) => {
        void wx.showToast({ icon: 'none', title: message });
        void this.closeSync();
      },
    });
  },

  async closeSync() {
    if (this.syncDebounce !== null) {
      clearTimeout(this.syncDebounce);
      this.syncDebounce = null;
    }
    const subscription = this.syncSubscription;
    this.syncSubscription = null;
    if (subscription !== null) await subscription.close();
  },
});

function buildDateSections(trip: TripDetail): readonly DateSection[] {
  return [...trip.dates].sort().map((date) => ({
    date,
    dateText: date.replaceAll('-', '.'),
    bills: trip.bills
      .filter((bill) => bill.date === date && bill.deletedAt === null)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(toBillCard),
  }));
}

function toBillCard(bill: TripBill): BillCard {
  return {
    ...bill,
    amountText: formatCents(bill.amountCents),
    invalid: bill.validationCodes.length > 0,
    participantText: bill.participants
      .map((item) => `${item.displayName}×${item.shares}`)
      .join('、'),
    payerText: bill.payers.map((item) => item.displayName).join('、'),
  };
}

function today(): string {
  const value = new Date();
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatCents(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。';
}

async function confirm(title: string, content: string): Promise<boolean> {
  const result = await wx.showModal({ title, content, confirmColor: '#167D73' });
  return result.confirm;
}
