export interface BillDraftMemberRow {
  paidYuan: string;
  participantSelected: boolean;
  payerSelected: boolean;
  shares: string;
  userId: string;
}

export interface BillDraft {
  amountYuan: string;
  memberRows: readonly BillDraftMemberRow[];
  ownerUserId: string;
  title: string;
}

const DRAFT_PREFIX = 'bill-draft-v2';
const LEGACY_DRAFT_PREFIX = 'bill-draft-v1';

export function readBillDraft(ownerUserId: string, tripId: string, date: string): BillDraft | null {
  removeLegacyDraft(tripId, date);
  const key = draftKey(ownerUserId, tripId, date);
  if (key === null) return null;
  try {
    const value = wx.getStorageSync<unknown>(key);
    return isBillDraft(value, ownerUserId) ? value : null;
  } catch {
    return null;
  }
}

export function writeBillDraft(
  ownerUserId: string,
  tripId: string,
  date: string,
  draft: Omit<BillDraft, 'ownerUserId'>,
): void {
  const key = draftKey(ownerUserId, tripId, date);
  if (key === null) return;
  const value: BillDraft = { ...draft, ownerUserId };
  if (!isBillDraft(value, ownerUserId)) return;
  try {
    wx.setStorageSync(key, value);
  } catch {
    // Draft persistence is optional and must not break page navigation.
  }
}

export function removeBillDraft(ownerUserId: string, tripId: string, date: string): void {
  const key = draftKey(ownerUserId, tripId, date);
  if (key !== null) {
    try {
      wx.removeStorageSync(key);
    } catch {
      // Best-effort after the authoritative bill has already saved.
    }
  }
  removeLegacyDraft(tripId, date);
}

function draftKey(ownerUserId: string, tripId: string, date: string): string | null {
  if (!isIdentifier(ownerUserId) || !isIdentifier(tripId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }
  return `${DRAFT_PREFIX}:${ownerUserId}:${tripId}:${date}`;
}

function legacyDraftKey(tripId: string, date: string): string | null {
  if (!isIdentifier(tripId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return `${LEGACY_DRAFT_PREFIX}:${tripId}:${date}`;
}

function removeLegacyDraft(tripId: string, date: string): void {
  const key = legacyDraftKey(tripId, date);
  if (key === null) return;
  try {
    wx.removeStorageSync(key);
  } catch {
    // Legacy unscoped drafts are never reused.
  }
}

function isBillDraft(value: unknown, ownerUserId: string): value is BillDraft {
  if (typeof value !== 'object' || value === null) return false;
  const draft = value as Record<string, unknown>;
  if (
    draft['ownerUserId'] !== ownerUserId ||
    typeof draft['amountYuan'] !== 'string' ||
    draft['amountYuan'].length > 16 ||
    typeof draft['title'] !== 'string' ||
    draft['title'].length > 24 ||
    !Array.isArray(draft['memberRows']) ||
    draft['memberRows'].length > 20
  ) {
    return false;
  }
  return draft['memberRows'].every((row: unknown) => {
    if (typeof row !== 'object' || row === null) return false;
    const member = row as Record<string, unknown>;
    return (
      typeof member['userId'] === 'string' &&
      isIdentifier(member['userId']) &&
      typeof member['paidYuan'] === 'string' &&
      member['paidYuan'].length <= 16 &&
      typeof member['participantSelected'] === 'boolean' &&
      typeof member['payerSelected'] === 'boolean' &&
      typeof member['shares'] === 'string' &&
      member['shares'].length <= 2
    );
  });
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/.test(value);
}
