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
  allocationWarning: string;
  loading: boolean;
  memberRows: readonly MemberRow[];
  saving: boolean;
  draftRestored: boolean;
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
  persistDraft(): void;
  refreshAllocationWarning(memberRows?: readonly MemberRow[], amountYuan?: string): void;
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
    allocationWarning: '',
    loading: true,
    memberRows: [],
    saving: false,
    draftRestored: false,
    title: '',
    trip: null,
    tripId: '',
  },

  onHide() {
    this.persistDraft();
  },

  onUnload() {
    this.persistDraft();
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
      const draft = existing === undefined ? readDraft(this.data.tripId, this.data.date) : null;
      const amountYuan =
        draft?.amountYuan ??
        (existing === undefined ? '' : (existing.amountCents / 100).toFixed(2));
      let memberRows = trip.members
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
        });
      if (draft !== null) memberRows = applyDraftRows(memberRows, draft.memberRows);
      this.setData({
        amountYuan,
        draftRestored: draft !== null,
        loading: false,
        memberRows,
        title: draft?.title ?? existing?.title ?? '',
        trip,
      });
      this.refreshAllocationWarning(memberRows, amountYuan);
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
    this.refreshAllocationWarning(memberRows, amountYuan);
  },

  toggleParticipant(event: WechatMiniprogram.BaseEvent) {
    const userId = String(event.currentTarget.dataset['userId'] ?? '');
    const memberRows = this.data.memberRows.map((member) =>
      member.userId === userId
        ? {
            ...member,
            participantSelected: !member.participantSelected,
            shares: member.participantSelected ? '0' : '1',
          }
        : member,
    );
    this.setData({ memberRows });
    this.refreshAllocationWarning(memberRows);
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
    this.refreshAllocationWarning(memberRows);
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
      removeDraft(this.data.tripId, this.data.date);
      void wx.navigateBack();
    } catch (error: unknown) {
      this.setData({ errorMessage: toMessage(error), saving: false });
    }
  },

  updateMemberValue(event: WechatMiniprogram.Input, key: 'paidYuan' | 'shares') {
    const userId = String(event.currentTarget.dataset['userId'] ?? '');
    const value = event.detail.value;
    const memberRows = this.data.memberRows.map((member) =>
      member.userId === userId ? { ...member, [key]: value } : member,
    );
    this.setData({ memberRows });
    this.refreshAllocationWarning(memberRows);
  },

  refreshAllocationWarning(memberRows?: readonly MemberRow[], amountYuan?: string) {
    const rows = memberRows ?? this.data.memberRows;
    const amount = amountYuan ?? this.data.amountYuan;
    const participants = rows.filter((member) => member.participantSelected);
    const shares = participants.map((member) => parseWholeNumber(member.shares));
    if (participants.length > 0 && shares.every((value) => value !== null)) {
      const shareTotal = shares.reduce<number>((sum, value) => sum + (value ?? 0), 0);
      if (shareTotal !== participants.length) {
        this.setData({
          allocationWarning: `参与人共 ${participants.length} 人，当前份额合计 ${shareTotal}，该账单不会参与分账。`,
        });
        return;
      }
    }
    const amountCents = parseCents(amount);
    const payerValues = rows
      .filter((member) => member.payerSelected)
      .map((member) => parseCents(member.paidYuan));
    if (
      amountCents !== null &&
      payerValues.length > 0 &&
      payerValues.every((value) => value !== null)
    ) {
      const paidTotal = payerValues.reduce<number>((sum, value) => sum + (value ?? 0), 0);
      if (paidTotal !== amountCents) {
        this.setData({
          allocationWarning: `付款合计 ${formatCents(paidTotal)}，应等于 ${formatCents(amountCents)}，该账单不会参与分账。`,
        });
        return;
      }
    }
    this.setData({ allocationWarning: '' });
  },

  persistDraft() {
    if (this.data.billId.length > 0 || this.data.saving || !hasDraftContent(this.data)) return;
    writeDraft(this.data.tripId, this.data.date, {
      amountYuan: this.data.amountYuan,
      memberRows: this.data.memberRows.map((member) => ({
        userId: member.userId,
        paidYuan: member.paidYuan,
        participantSelected: member.participantSelected,
        payerSelected: member.payerSelected,
        shares: member.shares,
      })),
      title: this.data.title,
    });
  },
});

interface BillDraft {
  amountYuan: string;
  memberRows: readonly Pick<
    MemberRow,
    'userId' | 'paidYuan' | 'participantSelected' | 'payerSelected' | 'shares'
  >[];
  title: string;
}

const DRAFT_PREFIX = 'bill-draft-v1';

function draftKey(tripId: string, date: string): string {
  return `${DRAFT_PREFIX}:${tripId}:${date}`;
}

function readDraft(tripId: string, date: string): BillDraft | null {
  try {
    const value = wx.getStorageSync<unknown>(draftKey(tripId, date));
    if (typeof value !== 'object' || value === null || !('memberRows' in value)) return null;
    return value as BillDraft;
  } catch {
    return null;
  }
}

function writeDraft(tripId: string, date: string, draft: BillDraft): void {
  if (tripId.length > 0 && date.length > 0) wx.setStorageSync(draftKey(tripId, date), draft);
}

function removeDraft(tripId: string, date: string): void {
  wx.removeStorageSync(draftKey(tripId, date));
}

function applyDraftRows(
  rows: readonly MemberRow[],
  draftRows: BillDraft['memberRows'],
): MemberRow[] {
  const draftById = new Map(draftRows.map((row) => [row.userId, row]));
  return rows.map((row) => ({ ...row, ...draftById.get(row.userId) }));
}

function hasDraftContent(data: BillEditorData): boolean {
  return data.title.trim().length > 0 || data.amountYuan.trim().length > 0;
}

function formatCents(value: number): string {
  return `¥${(value / 100).toFixed(2)}`;
}

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
