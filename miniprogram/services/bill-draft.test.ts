import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readBillDraft, removeBillDraft, writeBillDraft } from './bill-draft';

describe('account-scoped bill drafts', () => {
  const storage = new Map<string, unknown>();
  const draft = {
    amountYuan: '12.34',
    memberRows: [
      {
        paidYuan: '12.34',
        participantSelected: true,
        payerSelected: true,
        shares: '1',
        userId: 'usr_member',
      },
    ],
    title: '早餐',
  };

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal('wx', {
      getStorageSync: (key: string) => storage.get(key),
      removeStorageSync: (key: string) => storage.delete(key),
      setStorageSync: (key: string, value: unknown) => storage.set(key, structuredClone(value)),
    });
  });

  it('isolates the same trip and date by internal account id', () => {
    writeBillDraft('usr_alice', 'trp_shared', '2026-07-17', draft);

    expect(readBillDraft('usr_alice', 'trp_shared', '2026-07-17')).toMatchObject(draft);
    expect(readBillDraft('usr_bob', 'trp_shared', '2026-07-17')).toBeNull();
  });

  it('deletes but never imports a legacy unscoped draft', () => {
    const legacy = 'bill-draft-v1:trp_shared:2026-07-17';
    storage.set(legacy, draft);

    expect(readBillDraft('usr_alice', 'trp_shared', '2026-07-17')).toBeNull();
    expect(storage.has(legacy)).toBe(false);
  });

  it('rejects malformed or oversized stored drafts and removes account-scoped drafts', () => {
    const key = 'bill-draft-v2:usr_alice:trp_shared:2026-07-17';
    storage.set(key, {
      ...draft,
      ownerUserId: 'usr_alice',
      memberRows: Array(21).fill(draft.memberRows[0]),
    });
    expect(readBillDraft('usr_alice', 'trp_shared', '2026-07-17')).toBeNull();

    writeBillDraft('usr_alice', 'trp_shared', '2026-07-17', draft);
    removeBillDraft('usr_alice', 'trp_shared', '2026-07-17');
    expect(storage.has(key)).toBe(false);
  });
});
