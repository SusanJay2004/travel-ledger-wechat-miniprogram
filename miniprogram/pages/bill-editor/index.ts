import { callApi, type TripDetail, type TripMember } from '../../services/api';

interface MemberRow extends TripMember {
  paidYuan: string;
  participantSelected: boolean;
  payerSelected: boolean;
  shares: string;
}

interface BillEditorData {
  amountYuan: string;
  billId: string;
  date: string;
  dateText: string;
  errorMessage: string;
  loading: boolean;
  memberRows: readonly MemberRow[];
  saving: boolean;
  title: string;
  trip: TripDetail | null;
  tripId: string;
}

interface BillEditorMethods {
  handleAmountInput(event: WechatMiniprogram.Input): void;
  handlePaidInput(event: WechatMiniprogram.Input): void;
  handleShareInput(event: WechatMiniprogram.Input): void;
  handleSubmit(): Promise<void>;
  handleTitleInput(event: WechatMiniprogram.Input): void;
  loadTrip(): Promise<void>;
  toggleParticipant(event: WechatMiniprogram.BaseEvent): void;
  togglePayer(event: WechatMiniprogram.BaseEvent): void;
  updateMemberValue(event: WechatMiniprogram.Input, key: 'paidYuan' | 'shares'): void;
}

Page<BillEditorData, BillEditorMethods>({
  data: {
    amountYuan: '',
    billId: '',
    date: '',
    dateText: '',
    errorMessage: '',
    loading: true,
    memberRows: [],
    saving: false,
    title: '',
    trip: null,
    tripId: '',
  },

  onLoad(query: Record<string, string | undefined>) {
    const date = query['date'] ?? '';
    this.setData({
      billId: query['billId'] ?? '',
      date,
      dateText: date.replaceAll('-', '.'),
      tripId: query['tripId'] ?? '',
    });
    void this.loadTrip();
  },

  async loadTrip() {
    if (this.data.tripId.length === 0) {
      this.setData({ errorMessage: '缺少行程 ID。', loading: false });
      return;
    }
    try {
      const trip = await callApi<TripDetail>('trip.get', { tripId: this.data.tripId });
      const existing = trip.bills.find((bill) => bill.id === this.data.billId);
      this.setData({
        amountYuan: existing === undefined ? '' : (existing.amountCents / 100).toFixed(2),
        loading: false,
        memberRows: trip.members
          .filter((member) => member.viewState !== 'detached')
          .map((member, index) => {
            const participant = existing?.participants.find(
              (item) => item.memberId === member.userId,
            );
            const payer = existing?.payers.find((item) => item.memberId === member.userId);
            return {
              ...member,
              paidYuan: payer === undefined ? '' : (payer.paidCents / 100).toFixed(2),
              participantSelected: existing === undefined ? true : participant !== undefined,
              payerSelected: existing === undefined ? index === 0 : payer !== undefined,
              shares: String(participant?.shares ?? 1),
            };
          }),
        title: existing?.title ?? '',
        trip,
      });
    } catch (error: unknown) {
      this.setData({ errorMessage: toMessage(error), loading: false });
    }
  },

  handleTitleInput(event: WechatMiniprogram.Input) {
    this.setData({ title: event.detail.value, errorMessage: '' });
  },

  handleAmountInput(event: WechatMiniprogram.Input) {
    const amountYuan = event.detail.value;
    const selectedPayers = this.data.memberRows.filter((member) => member.payerSelected);
    const memberRows = this.data.memberRows.map((member) =>
      selectedPayers.length === 1 && member.userId === selectedPayers[0]?.userId
        ? { ...member, paidYuan: amountYuan }
        : member,
    );
    this.setData({ amountYuan, errorMessage: '', memberRows });
  },

  toggleParticipant(event: WechatMiniprogram.BaseEvent) {
    const userId = String(event.currentTarget.dataset['userId'] ?? '');
    this.setData({
      memberRows: this.data.memberRows.map((member) =>
        member.userId === userId
          ? {
              ...member,
              participantSelected: !member.participantSelected,
              shares: member.participantSelected ? '0' : '1',
            }
          : member,
      ),
    });
  },

  togglePayer(event: WechatMiniprogram.BaseEvent) {
    const userId = String(event.currentTarget.dataset['userId'] ?? '');
    const next = this.data.memberRows.map((member) =>
      member.userId === userId
        ? {
            ...member,
            paidYuan: member.payerSelected ? '' : member.paidYuan,
            payerSelected: !member.payerSelected,
          }
        : member,
    );
    const selected = next.filter((member) => member.payerSelected);
    const memberRows = next.map((member) =>
      selected.length === 1 && member.userId === selected[0]?.userId
        ? { ...member, paidYuan: this.data.amountYuan }
        : member,
    );
    this.setData({ memberRows });
  },

  handleShareInput(event: WechatMiniprogram.Input) {
    this.updateMemberValue(event, 'shares');
  },

  handlePaidInput(event: WechatMiniprogram.Input) {
    this.updateMemberValue(event, 'paidYuan');
  },

  async handleSubmit() {
    const trip = this.data.trip;
    if (trip === null || this.data.saving) return;
    const title = this.data.title.trim();
    const amountCents = parseCents(this.data.amountYuan);
    if (title.length === 0 || [...title].length > 12) {
      this.setData({ errorMessage: '事件必填且不能超过 12 个字符。' });
      return;
    }
    if (amountCents === null || amountCents < 1 || amountCents > 999_999_900) {
      this.setData({ errorMessage: '请输入 ¥0.01–¥9,999,999.00 的消费金额。' });
      return;
    }
    const participantRows = this.data.memberRows.filter((member) => member.participantSelected);
    const payerRows = this.data.memberRows.filter((member) => member.payerSelected);
    if (participantRows.length === 0 || payerRows.length === 0) {
      this.setData({ errorMessage: '请至少选择一名参与人和一名付款人。' });
      return;
    }
    const participants = participantRows.map((member) => ({
      memberId: member.userId,
      displayName: member.displayNameSnapshot,
      shares: parseWholeNumber(member.shares),
    }));
    const payers = payerRows.map((member) => ({
      memberId: member.userId,
      displayName: member.displayNameSnapshot,
      paidCents: parseCents(member.paidYuan),
    }));
    if (
      participants.some((item) => item.shares === null) ||
      payers.some((item) => item.paidCents === null)
    ) {
      this.setData({ errorMessage: '份额必须是 0–20 的整数，实付金额需精确到分。' });
      return;
    }

    this.setData({ saving: true });
    try {
      await callApi(this.data.billId.length > 0 ? 'trip.updateBill' : 'trip.addBill', {
        tripId: trip.id,
        billId: this.data.billId,
        date: this.data.date,
        expectedVersion: trip.version,
        bill: { title, amountCents, participants, payers },
      });
      void wx.navigateBack();
    } catch (error: unknown) {
      this.setData({ errorMessage: toMessage(error), saving: false });
    }
  },

  updateMemberValue(event: WechatMiniprogram.Input, key: 'paidYuan' | 'shares') {
    const userId = String(event.currentTarget.dataset['userId'] ?? '');
    const value = event.detail.value;
    this.setData({
      memberRows: this.data.memberRows.map((member) =>
        member.userId === userId ? { ...member, [key]: value } : member,
      ),
    });
  },
});

function parseCents(value: string): number | null {
  const match = /^(?:0|[1-9]\d{0,6})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (match === null) return null;
  const [yuan = '0', fraction = ''] = value.trim().split('.');
  return Number(yuan) * 100 + Number(fraction.padEnd(2, '0'));
}

function parseWholeNumber(value: string): number | null {
  if (!/^(?:[0-9]|1[0-9]|20)$/.test(value.trim())) return null;
  return Number(value);
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : '保存失败，请稍后重试。';
}
