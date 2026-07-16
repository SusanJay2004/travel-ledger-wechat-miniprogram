import {
  ApiError,
  callApi,
  type SettlementResponse,
  type TripBill,
  type TripDetail,
} from '../../services/api';

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
  dateSections: readonly DateSection[];
  errorMessage: string;
  loading: boolean;
  selectedDate: string;
  trip: TripDetail | null;
  totalText: string;
}

interface DetailMethods {
  handleAddBill(event: WechatMiniprogram.BaseEvent): void;
  handleArchive(): Promise<void>;
  handleComplete(): Promise<void>;
  handleDateChange(event: WechatMiniprogram.PickerChange): void;
  handleRetry(): void;
  handleSettle(): Promise<void>;
  loadTrip(): Promise<void>;
  submitDate(): Promise<void>;
}

Page<DetailData, DetailMethods>({
  data: {
    addingDate: false,
    dateSections: [],
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

  async loadTrip() {
    const tripId = this.data.trip?.id;
    if (tripId === undefined) {
      this.setData({ errorMessage: '缺少行程 ID。', loading: false });
      return;
    }
    this.setData({ errorMessage: '', loading: true });
    try {
      const trip = await callApi<TripDetail>('trip.get', { tripId });
      void wx.setNavigationBarTitle({ title: trip.name });
      this.setData({
        dateSections: buildDateSections(trip),
        loading: false,
        trip,
        totalText: formatCents(trip.totalCents),
      });
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

  async handleSettle() {
    const trip = this.data.trip;
    if (trip === null) return;
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
});

function buildDateSections(trip: TripDetail): readonly DateSection[] {
  return [...trip.dates].sort().map((date) => ({
    date,
    dateText: date.replaceAll('-', '.'),
    bills: trip.bills
      .filter((bill) => bill.date === date && bill.deletedAt === null)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((bill) => ({
        ...bill,
        amountText: formatCents(bill.amountCents),
        invalid: bill.validationCodes.length > 0,
        participantText: bill.participants
          .map((item) => `${item.displayName}×${item.shares}`)
          .join('、'),
        payerText: bill.payers.map((item) => item.displayName).join('、'),
      })),
  }));
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
