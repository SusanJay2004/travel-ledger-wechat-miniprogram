import { callApi, type TripDetail } from '../../services/api';
import {
  isVersionConflict,
  reconcileBillConflict,
  type ConflictMemberRow,
} from '../../services/conflict';

type MemberRow = ConflictMemberRow;

interface BillEditorData {
  amountYuan: string;
  billId: string;
  date: string;
  dateText: string;
  dateOptions: readonly string[];
  dateOptionTexts: readonly string[];
  dateSelectedIndex: number;
  errorMessage: string;
  allocationWarning: string;
  loading: boolean;
  memberRows: readonly MemberRow[];
  saving: boolean;
  draftRestored: boolean;
  title: string;
  trip: TripDetail | null;
  tripId: string;
  writeBlockedReason: string;
}

interface BillEditorMethods {
  handleAmountInput(event: WechatMiniprogram.Input): void;
  handleDateChange(event: WechatMiniprogram.PickerChange): void;
  handlePaidInput(event: WechatMiniprogram.Input): void;
  handleShareInput(event: WechatMiniprogram.Input): void;
  handleSubmit(): Promise<void>;
  handleVersionConflict(): Promise<void>;
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
    dateOptions: [],
    dateOptionTexts: [],
    dateSelectedIndex: 0,
    errorMessage: '',
    allocationWarning: '',
    loading: true,
    memberRows: [],
    saving: false,
    draftRestored: false,
    title: '',
    trip: null,
    tripId: '',
    writeBlockedReason: '',
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
      const writeBlockedReason =
        trip.status === 'completed'
          ? '行程已完结，当前账本为只读。'
          : this.data.billId.length > 0 && (existing === undefined || existing.deletedAt !== null)
            ? '这笔账单已被删除，不能直接覆盖；请先从活动记录恢复。'
            : '';
      this.setData({
        amountYuan,
        date: existing?.date ?? this.data.date,
        dateOptions: [...trip.dates].sort(),
        dateOptionTexts: [...trip.dates].sort().map(formatDate),
        dateSelectedIndex: Math.max(
          0,
          [...trip.dates].sort().indexOf(existing?.date ?? this.data.date),
        ),
        dateText: formatDate(existing?.date ?? this.data.date),
        draftRestored: draft !== null,
        loading: false,
        memberRows,
        title: draft?.title ?? existing?.title ?? '',
        trip,
        writeBlockedReason,
      });
      this.refreshAllocationWarning(memberRows, amountYuan);
    } catch (error: unknown) {
      this.setData({ errorMessage: toMessage(error), loading: false });
    }
  },

  handleTitleInput(event: WechatMiniprogram.Input) {
    if (this.data.writeBlockedReason.length > 0) return;
    this.setData({ title: event.detail.value, errorMessage: '' });
  },

  handleDateChange(event: WechatMiniprogram.PickerChange) {
    if (this.data.writeBlockedReason.length > 0) return;
    const index = Number(event.detail.value);
    const date = this.data.dateOptions[index];
    if (date === undefined) return;
    this.setData({ date, dateSelectedIndex: index, dateText: formatDate(date) });
  },

  handleAmountInput(event: WechatMiniprogram.Input) {
    if (this.data.writeBlockedReason.length > 0) return;
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
    if (this.data.writeBlockedReason.length > 0) return;
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
    if (this.data.writeBlockedReason.length > 0) return;
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
    if (trip === null || this.data.saving || this.data.writeBlockedReason.length > 0) return;
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
      if (isVersionConflict(error)) {
        await this.handleVersionConflict();
        return;
      }
      this.setData({ errorMessage: toMessage(error), saving: false });
    }
  },

  async handleVersionConflict() {
    const currentRows = this.data.memberRows;
    try {
      const latest = await callApi<TripDetail>('trip.get', { tripId: this.data.tripId });
      const resolution = reconcileBillConflict(
        latest,
        this.data.billId,
        this.data.date,
        currentRows,
      );
      if (resolution.billDeleted) {
        await wx.showModal({
          title: '这笔账单已被删除',
          content: '同行人已经删除了这笔账单，当前输入不会覆盖该操作。',
          showCancel: false,
        });
        this.setData({
          errorMessage: '账单已被删除，请返回行程查看最新内容。',
          saving: false,
          trip: latest,
          writeBlockedReason: '这笔账单已被删除，不能直接覆盖；请先从活动记录恢复。',
        });
        return;
      }
      await wx.showModal({
        title: latest.status === 'completed' ? '行程已完结' : '账本刚刚被修改',
        content:
          latest.status === 'completed'
            ? '已保留你的当前输入，但同行人已完结行程，账本现在为只读。'
            : '已保留你的事件、金额和分配，并刷新最新成员、日期和版本。请检查后再次保存。',
        showCancel: false,
        confirmText: latest.status === 'completed' ? '查看最新行程' : '检查并重试',
        confirmColor: '#0F6E65',
      });
      this.setData({
        date: resolution.date,
        dateOptions: resolution.dateOptions,
        dateOptionTexts: resolution.dateOptions.map(formatDate),
        dateSelectedIndex: Math.max(0, resolution.dateOptions.indexOf(resolution.date)),
        dateText: formatDate(resolution.date),
        errorMessage:
          latest.status === 'completed'
            ? '行程已完结，当前输入未提交。'
            : '同行人已更新账本，请检查最新成员和日期后再次保存。',
        memberRows: resolution.memberRows,
        saving: false,
        trip: latest,
        writeBlockedReason: latest.status === 'completed' ? '行程已完结，当前账本为只读。' : '',
      });
      this.refreshAllocationWarning(resolution.memberRows);
    } catch (refreshError: unknown) {
      this.setData({ errorMessage: toMessage(refreshError), saving: false });
    }
  },

  updateMemberValue(event: WechatMiniprogram.Input, key: 'paidYuan' | 'shares') {
    if (this.data.writeBlockedReason.length > 0) return;
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

function formatDate(value: string): string {
  return value.replaceAll('-', '.');
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
