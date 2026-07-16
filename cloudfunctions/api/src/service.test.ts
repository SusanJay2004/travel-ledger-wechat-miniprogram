import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Clock, IdGenerator, UserDocument } from './models';
import { MemoryRepository } from './repository';
import { LedgerService } from './service';
import { MemorySocialRepository } from './social-repository';

class TestClock implements Clock {
  constructor(private current = new Date('2026-07-10T08:00:00.000Z')) {}

  now() {
    return new Date(this.current);
  }

  advanceDays(days: number) {
    this.current = new Date(this.current.getTime() + days * 24 * 60 * 60 * 1000);
  }
}

class TestIds implements IdGenerator {
  private sequence = 0;

  entityId(prefix: string) {
    this.sequence += 1;
    return `${prefix}_${this.sequence}`;
  }

  publicId() {
    this.sequence += 1;
    return `TESTID${String(this.sequence).padStart(4, '0')}`;
  }

  sceneToken() {
    this.sequence += 1;
    return `scenetoken${String(this.sequence).padStart(10, '0')}`;
  }
}

describe('LedgerService solo flow', () => {
  let repository: MemoryRepository;
  let clock: TestClock;
  let service: LedgerService;
  let user: UserDocument;

  beforeEach(async () => {
    repository = new MemoryRepository();
    clock = new TestClock();
    service = new LedgerService(repository, clock, new TestIds());
    user = await service.bootstrapSession('openid-alice');
  });

  it('bootstraps the same account idempotently', async () => {
    const second = await service.bootstrapSession('openid-alice');
    expect(second).toEqual(user);
    expect(user.publicId).toHaveLength(10);
    expect(user.displayName).toBe(`旅人${user.publicId.slice(-6)}`);
  });

  it('creates, dates and lists a trip in chronological order', async () => {
    const later = await service.createTrip(user, { name: '青岛 2026' });
    await service.addDate(user.id, {
      tripId: later.id,
      date: '2026-07-10',
      expectedVersion: later.version,
    });
    const earlier = await service.createTrip(user, { name: '北京之旅' });
    await service.addDate(user.id, {
      tripId: earlier.id,
      date: '2026-07-08',
      expectedVersion: earlier.version,
    });

    expect((await service.listTrips(user.id)).map((trip) => trip.name)).toEqual([
      '北京之旅',
      '青岛 2026',
    ]);
  });

  it('stores an invalid allocation but excludes it from settlement', async () => {
    const trip = await service.createTrip(user, { name: '毕业旅行' });
    const dated = await service.addDate(user.id, {
      tripId: trip.id,
      date: '2026-07-10',
      expectedVersion: trip.version,
    });
    const withBill = await service.addBill(user.id, {
      tripId: trip.id,
      date: '2026-07-10',
      expectedVersion: dated.version,
      bill: {
        title: '酒店',
        amountCents: 30_000,
        participants: [{ memberId: user.id, displayName: user.displayName, shares: 0 }],
        payers: [{ memberId: user.id, displayName: user.displayName, paidCents: 29_999 }],
      },
    });

    expect(withBill.totalCents).toBe(30_000);
    expect(withBill.invalidBillCount).toBe(1);
    const settlement = await service.calculate(user.id, trip.id);
    expect(settlement.includedCents).toBe(0);
    expect(settlement.ignoredBillIds).toHaveLength(1);
    expect(settlement.result.transfers).toEqual([]);
  });

  it('caches a settlement by ledger revision and invalidates it on mutation', async () => {
    const trip = await service.createTrip(user, { name: '结算缓存' });
    const dated = await service.addDate(user.id, {
      tripId: trip.id,
      date: '2026-07-10',
      expectedVersion: trip.version,
    });
    const billed = await service.addBill(user.id, {
      tripId: trip.id,
      date: '2026-07-10',
      expectedVersion: dated.version,
      bill: {
        title: '午餐',
        amountCents: 8000,
        participants: [{ memberId: user.id, displayName: user.displayName, shares: 1 }],
        payers: [{ memberId: user.id, displayName: user.displayName, paidCents: 8000 }],
      },
    });

    const first = await service.calculate(user.id, trip.id);
    const cached = await repository.getTrip(trip.id);
    expect(first.ledgerRevision).toBe(billed.ledgerRevision);
    expect(cached?.settlementCache?.ledgerRevision).toBe(billed.ledgerRevision);
    expect(cached?.version).toBe(billed.version);

    const deleted = await service.deleteBill(user.id, {
      tripId: trip.id,
      billId: billed.bills[0]!.id,
      expectedVersion: billed.version,
    });
    expect(deleted.settlementCache).toBeNull();
    const recalculated = await service.calculate(user.id, trip.id);
    expect(recalculated.ledgerRevision).toBe(deleted.ledgerRevision);
    expect(recalculated.includedCents).toBe(0);
  });

  it('requires explicit confirmation before completing with invalid bills', async () => {
    const trip = await service.createTrip(user, { name: '有待办账单' });
    const dated = await service.addDate(user.id, {
      tripId: trip.id,
      date: '2026-07-10',
      expectedVersion: trip.version,
    });
    const billed = await service.addBill(user.id, {
      tripId: trip.id,
      date: '2026-07-10',
      expectedVersion: dated.version,
      bill: {
        title: '晚餐',
        amountCents: 100,
        participants: [{ memberId: user.id, displayName: user.displayName, shares: 0 }],
        payers: [{ memberId: user.id, displayName: user.displayName, paidCents: 100 }],
      },
    });

    await expect(
      service.completeTrip(user.id, {
        tripId: trip.id,
        expectedVersion: billed.version,
        ignoreInvalidBills: false,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_BILLS_REQUIRE_CONFIRMATION' });
    const completed = await service.completeTrip(user.id, {
      tripId: trip.id,
      expectedVersion: billed.version,
      ignoreInvalidBills: true,
    });
    expect(completed.status).toBe('completed');
  });

  it('archives per user for 30 days and restores to home', async () => {
    const trip = await service.createTrip(user, { name: '归档之旅' });
    const completed = await service.completeTrip(user.id, {
      tripId: trip.id,
      expectedVersion: trip.version,
      ignoreInvalidBills: false,
    });
    const archived = await service.archiveTrip(user.id, {
      tripId: trip.id,
      expectedVersion: completed.version,
    });
    expect((await repository.getUser(user.id))?.homeTripCount).toBe(0);
    await expect(
      service.archiveTrip(user.id, {
        tripId: trip.id,
        expectedVersion: archived.version,
      }),
    ).rejects.toMatchObject({ code: 'TRIP_NOT_IN_HOME' });
    const archivedMember = archived.members[0];
    expect(archivedMember?.viewState).toBe('archived');
    expect(archivedMember?.purgeAfter).toBe('2026-08-09T08:00:00.000Z');
    expect(await service.listTrips(user.id)).toEqual([]);

    clock.advanceDays(1);
    const restored = await service.restoreTrip(user.id, {
      tripId: trip.id,
      expectedVersion: archived.version,
    });
    expect(restored.members[0]?.viewState).toBe('home');
    expect((await repository.getUser(user.id))?.homeTripCount).toBe(1);
    expect(await service.listTrips(user.id)).toHaveLength(1);
  });

  it('rejects restoration after 30 days and allows permanent detachment', async () => {
    const expiredTrip = await service.createTrip(user, { name: '过期归档' });
    const completed = await service.completeTrip(user.id, {
      tripId: expiredTrip.id,
      expectedVersion: expiredTrip.version,
      ignoreInvalidBills: false,
    });
    const archived = await service.archiveTrip(user.id, {
      tripId: expiredTrip.id,
      expectedVersion: completed.version,
    });
    clock.advanceDays(30);
    await expect(
      service.restoreTrip(user.id, {
        tripId: expiredTrip.id,
        expectedVersion: archived.version,
      }),
    ).rejects.toMatchObject({ code: 'TRIP_RESTORE_EXPIRED' });
    expect(await service.listArchivedTrips(user.id)).toEqual([]);

    const removable = await service.createTrip(user, { name: '主动清理' });
    const removableCompleted = await service.completeTrip(user.id, {
      tripId: removable.id,
      expectedVersion: removable.version,
      ignoreInvalidBills: false,
    });
    const removableArchived = await service.archiveTrip(user.id, {
      tripId: removable.id,
      expectedVersion: removableCompleted.version,
    });
    const detached = await service.removeArchivedTrip(user.id, {
      tripId: removable.id,
      expectedVersion: removableArchived.version,
    });
    expect(detached.members[0]?.viewState).toBe('detached');
    await expect(service.getTrip(user.id, removable.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('reopens a completed trip and clears completion metadata', async () => {
    const trip = await service.createTrip(user, { name: '重新出发' });
    const completed = await service.completeTrip(user.id, {
      tripId: trip.id,
      expectedVersion: trip.version,
      ignoreInvalidBills: false,
    });
    const reopened = await service.reopenTrip(user.id, {
      tripId: trip.id,
      expectedVersion: completed.version,
    });
    expect(reopened.status).toBe('active');
    expect(reopened.completedAt).toBeNull();
    expect(reopened.completedBy).toBeNull();
  });

  it('allows a retained home member at capacity to reopen without adding another home trip', async () => {
    const trip = await service.createTrip(user, { name: '首页满额重开' });
    const completed = await service.completeTrip(user.id, {
      tripId: trip.id,
      expectedVersion: trip.version,
      ignoreInvalidBills: false,
    });
    const countHomeTrips = vi.spyOn(repository, 'countHomeTrips');
    countHomeTrips.mockClear();

    const reopened = await service.reopenTrip(user.id, {
      tripId: trip.id,
      expectedVersion: completed.version,
    });

    expect(reopened.status).toBe('active');
    expect(reopened.members[0]?.viewState).toBe('home');
    expect(countHomeTrips).not.toHaveBeenCalled();
  });

  it('restores every retained archived member on reopen and enforces their home capacity', async () => {
    const trip = await service.createTrip(user, { name: '全员恢复' });
    const completed = await service.completeTrip(user.id, {
      tripId: trip.id,
      expectedVersion: trip.version,
      ignoreInvalidBills: false,
    });
    const archived = await service.archiveTrip(user.id, {
      tripId: trip.id,
      expectedVersion: completed.version,
    });
    const archivedUser = (await repository.getUser(user.id))!;
    await repository.updateUser(
      { ...archivedUser, homeTripCount: 100, version: archivedUser.version + 1 },
      archivedUser.version,
    );
    await expect(
      service.reopenTrip(user.id, {
        tripId: trip.id,
        expectedVersion: archived.version,
      }),
    ).rejects.toMatchObject({ code: 'MEMBER_TRIP_LIMIT_REACHED' });

    const fullUser = (await repository.getUser(user.id))!;
    await repository.updateUser(
      { ...fullUser, homeTripCount: 99, version: fullUser.version + 1 },
      fullUser.version,
    );
    const reopened = await service.reopenTrip(user.id, {
      tripId: trip.id,
      expectedVersion: archived.version,
    });
    expect(reopened.members[0]).toMatchObject({
      viewState: 'home',
      archivedAt: null,
      purgeAfter: null,
    });
  });

  it('rejects stale writes without overwriting current data', async () => {
    const trip = await service.createTrip(user, { name: '并发之旅' });
    await service.addDate(user.id, {
      tripId: trip.id,
      date: '2026-07-10',
      expectedVersion: trip.version,
    });

    await expect(
      service.addDate(user.id, {
        tripId: trip.id,
        date: '2026-07-11',
        expectedVersion: trip.version,
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect((await service.getTrip(user.id, trip.id)).dates).toEqual(['2026-07-10']);
  });

  it('deletes only an empty date and restores it with a soft-deleted bill', async () => {
    const trip = await service.createTrip(user, { name: '日期整理' });
    const dated = await service.addDate(user.id, {
      tripId: trip.id,
      date: '2026-07-10',
      expectedVersion: trip.version,
    });
    const billed = await service.addBill(user.id, {
      tripId: trip.id,
      date: '2026-07-10',
      expectedVersion: dated.version,
      bill: {
        title: '车票',
        amountCents: 100,
        participants: [{ memberId: user.id, displayName: user.displayName, shares: 1 }],
        payers: [{ memberId: user.id, displayName: user.displayName, paidCents: 100 }],
      },
    });

    await expect(
      service.deleteDate(user.id, {
        tripId: trip.id,
        date: '2026-07-10',
        expectedVersion: billed.version,
      }),
    ).rejects.toMatchObject({ code: 'DATE_HAS_BILLS' });

    const deletedBill = await service.deleteBill(user.id, {
      tripId: trip.id,
      billId: billed.bills[0]!.id,
      expectedVersion: billed.version,
    });
    const deletedDate = await service.deleteDate(user.id, {
      tripId: trip.id,
      date: '2026-07-10',
      expectedVersion: deletedBill.version,
    });
    expect(deletedDate.dates).toEqual([]);
    expect(deletedDate.ledgerRevision).toBe(deletedBill.ledgerRevision + 1);

    const restored = await service.restoreBill(user.id, {
      tripId: trip.id,
      billId: billed.bills[0]!.id,
      expectedVersion: deletedDate.version,
    });
    expect(restored.dates).toEqual(['2026-07-10']);
    expect(restored.totalCents).toBe(100);
  });

  it('moves an existing bill to another date without changing the total', async () => {
    const trip = await service.createTrip(user, { name: '移动账单' });
    const firstDate = await service.addDate(user.id, {
      tripId: trip.id,
      date: '2026-07-10',
      expectedVersion: trip.version,
    });
    const secondDate = await service.addDate(user.id, {
      tripId: trip.id,
      date: '2026-07-11',
      expectedVersion: firstDate.version,
    });
    const billed = await service.addBill(user.id, {
      tripId: trip.id,
      date: '2026-07-10',
      expectedVersion: secondDate.version,
      bill: {
        title: '早餐',
        amountCents: 2400,
        participants: [{ memberId: user.id, displayName: user.displayName, shares: 1 }],
        payers: [{ memberId: user.id, displayName: user.displayName, paidCents: 2400 }],
      },
    });

    const moved = await service.updateBill(user.id, {
      tripId: trip.id,
      billId: billed.bills[0]!.id,
      date: '2026-07-11',
      expectedVersion: billed.version,
      bill: billed.bills[0]!,
    });
    expect(moved.bills[0]?.date).toBe('2026-07-11');
    expect(moved.totalCents).toBe(2400);
  });

  it('prevents non-members from reading a trip', async () => {
    const trip = await service.createTrip(user, { name: '私密旅程' });
    const bob = await service.bootstrapSession('openid-bob');
    await expect(service.getTrip(bob.id, trip.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('updates profile fields while preserving identity', async () => {
    const updated = await service.updateProfile(user, {
      displayName: '苏同学',
      signature: '出发去看海',
      avatarUrl: null,
    });
    expect(updated.id).toBe(user.id);
    expect(updated.publicId).toBe(user.publicId);
    expect(updated.displayName).toBe('苏同学');
    expect(updated.version).toBe(user.version + 1);
  });

  it('rejects a stale profile update instead of overwriting newer user state', async () => {
    const first = await service.updateProfile(user, {
      displayName: '第一次修改',
      signature: user.signature,
      avatarUrl: null,
    });

    await expect(
      service.updateProfile(user, {
        displayName: '过期覆盖',
        signature: user.signature,
        avatarUrl: null,
      }),
    ).rejects.toMatchObject({ code: 'PROFILE_VERSION_CONFLICT' });
    expect((await repository.getUser(user.id))?.displayName).toBe(first.displayName);
  });

  it('only accepts avatar files from the current account directory', async () => {
    await expect(
      service.updateProfile(user, {
        displayName: user.displayName,
        signature: user.signature,
        avatarUrl: 'cloud://development/avatars/usr_other/avatar.png',
      }),
    ).rejects.toMatchObject({ code: 'AVATAR_OWNERSHIP_INVALID' });

    const updated = await service.updateProfile(user, {
      displayName: user.displayName,
      signature: user.signature,
      avatarUrl: `cloud://development/avatars/${user.id}/avatar.png`,
    });
    expect(updated.avatarUrl).toBe(`cloud://development/avatars/${user.id}/avatar.png`);
  });

  it('anonymizes ledger history and permits a fresh account after deletion', async () => {
    const trip = await service.createTrip(user, { name: '注销前行程' });
    const dated = await service.addDate(user.id, {
      tripId: trip.id,
      date: '2026-07-10',
      expectedVersion: trip.version,
    });
    await service.addBill(user.id, {
      tripId: trip.id,
      date: '2026-07-10',
      expectedVersion: dated.version,
      bill: {
        title: '车票',
        amountCents: 100,
        participants: [{ memberId: user.id, displayName: user.displayName, shares: 1 }],
        payers: [{ memberId: user.id, displayName: user.displayName, paidCents: 100 }],
      },
    });
    const currentUser = (await repository.getUser(user.id))!;
    const withAvatar = await service.updateProfile(currentUser, {
      displayName: user.displayName,
      signature: user.signature,
      avatarUrl: `cloud://development/avatars/${user.id}/avatar.png`,
    });
    const withFiles = {
      ...withAvatar,
      qrCodeFileId: `cloud://development/profile-codes/${user.id}/code.png`,
      version: withAvatar.version + 1,
    };
    await repository.updateUser(withFiles, withAvatar.version);
    await service.deleteAccount(withFiles, new MemorySocialRepository());

    expect(await repository.getUser(user.id)).toMatchObject({
      qrSceneToken: null,
      pendingFileDeletionIds: [
        `cloud://development/avatars/${user.id}/avatar.png`,
        `cloud://development/profile-codes/${user.id}/code.png`,
      ],
    });

    const historical = await repository.getTrip(trip.id);
    expect(historical?.members[0]?.displayNameSnapshot).toBe('已注销用户');
    expect(historical?.members[0]?.viewState).toBe('detached');
    expect(historical?.bills[0]?.participants[0]?.displayName).toBe('已注销用户');
    expect(historical?.bills[0]?.amountCents).toBe(100);

    const fresh = await service.bootstrapSession('openid-alice');
    expect(fresh.id).not.toBe(user.id);
    expect(fresh.status).toBe('active');
  });

  it('updates, soft deletes and restores a bill without losing cents', async () => {
    const trip = await service.createTrip(user, { name: '可纠错旅程' });
    const dated = await service.addDate(user.id, {
      tripId: trip.id,
      date: '2026-07-10',
      expectedVersion: trip.version,
    });
    const added = await service.addBill(user.id, {
      tripId: trip.id,
      date: '2026-07-10',
      expectedVersion: dated.version,
      bill: {
        title: '午餐',
        amountCents: 100,
        participants: [{ memberId: user.id, displayName: user.displayName, shares: 1 }],
        payers: [{ memberId: user.id, displayName: user.displayName, paidCents: 100 }],
      },
    });
    const billId = added.bills[0]?.id;
    expect(billId).toBeDefined();
    const updated = await service.updateBill(user.id, {
      tripId: trip.id,
      billId: billId!,
      date: '2026-07-10',
      expectedVersion: added.version,
      bill: {
        title: '晚餐',
        amountCents: 250,
        participants: [{ memberId: user.id, displayName: user.displayName, shares: 1 }],
        payers: [{ memberId: user.id, displayName: user.displayName, paidCents: 250 }],
      },
    });
    expect(updated.totalCents).toBe(250);
    const deleted = await service.deleteBill(user.id, {
      tripId: trip.id,
      billId: billId!,
      expectedVersion: updated.version,
    });
    expect(deleted.totalCents).toBe(0);
    expect(deleted.bills[0]?.deletedAt).not.toBeNull();
    const restored = await service.restoreBill(user.id, {
      tripId: trip.id,
      billId: billId!,
      expectedVersion: deleted.version,
    });
    expect(restored.totalCents).toBe(250);
    expect(restored.bills[0]?.deletedAt).toBeNull();
  });

  it('preserves historical detached references but rejects them in new bills', async () => {
    const bob = await service.bootstrapSession('openid-historical-bob');
    const trip = await service.createTrip(user, { name: '历史成员账单' });
    const joined = {
      ...trip,
      memberIds: [...trip.memberIds, bob.id],
      members: [
        ...trip.members,
        {
          userId: bob.id,
          displayNameSnapshot: bob.displayName,
          joinedAt: clock.now().toISOString(),
          viewState: 'home' as const,
          archivedAt: null,
          purgeAfter: null,
        },
      ],
    };
    await repository.replaceTrip(joined, trip.version);
    const dated = await service.addDate(user.id, {
      tripId: trip.id,
      date: '2026-07-10',
      expectedVersion: joined.version,
    });
    const billed = await service.addBill(user.id, {
      tripId: trip.id,
      date: '2026-07-10',
      expectedVersion: dated.version,
      bill: {
        title: '共同车票',
        amountCents: 200,
        participants: [
          { memberId: user.id, displayName: user.displayName, shares: 1 },
          { memberId: bob.id, displayName: bob.displayName, shares: 1 },
        ],
        payers: [{ memberId: user.id, displayName: user.displayName, paidCents: 200 }],
      },
    });
    const detached = {
      ...billed,
      members: billed.members.map((member) =>
        member.userId === bob.id ? { ...member, viewState: 'detached' as const } : member,
      ),
    };
    await repository.replaceTrip(detached, billed.version);

    const corrected = await service.updateBill(user.id, {
      tripId: trip.id,
      billId: billed.bills[0]!.id,
      date: '2026-07-10',
      expectedVersion: detached.version,
      bill: { ...billed.bills[0]!, title: '共同车票更正' },
    });
    await expect(
      service.addBill(user.id, {
        tripId: trip.id,
        date: '2026-07-10',
        expectedVersion: corrected.version,
        bill: {
          title: '违规新账单',
          amountCents: 100,
          participants: [{ memberId: bob.id, displayName: bob.displayName, shares: 1 }],
          payers: [{ memberId: user.id, displayName: user.displayName, paidCents: 100 }],
        },
      }),
    ).rejects.toMatchObject({ code: 'MEMBER_NOT_IN_TRIP' });
  });

  it('replaces forged bill display names with trusted member snapshots', async () => {
    const trip = await service.createTrip(user, { name: '可信姓名' });
    const dated = await service.addDate(user.id, {
      tripId: trip.id,
      date: '2026-07-10',
      expectedVersion: trip.version,
    });
    const added = await service.addBill(user.id, {
      tripId: trip.id,
      date: '2026-07-10',
      expectedVersion: dated.version,
      bill: {
        title: '  午餐  ',
        amountCents: 100,
        participants: [{ memberId: user.id, displayName: '伪造参与人', shares: 1 }],
        payers: [{ memberId: user.id, displayName: '伪造付款人', paidCents: 100 }],
      },
    });

    expect(added.bills[0]?.participants[0]?.displayName).toBe(user.displayName);
    expect(added.bills[0]?.payers[0]?.displayName).toBe(user.displayName);
    expect(added.bills[0]?.title).toBe('午餐');
  });

  it('enforces the 100 home-trip limit at the service boundary', async () => {
    const fullUser = { ...user, homeTripCount: 100, version: user.version + 1 };
    await repository.updateUser(fullUser, user.version);
    await expect(service.createTrip(fullUser, { name: '超额行程' })).rejects.toMatchObject({
      code: 'TRIP_LIMIT_REACHED',
    });
  });

  it('enforces the 100 active-bill limit while allowing soft-deleted slots to be reused', async () => {
    const trip = await service.createTrip(user, { name: '百笔账单' });
    const dated = await service.addDate(user.id, {
      tripId: trip.id,
      date: '2026-07-10',
      expectedVersion: trip.version,
    });
    let current = dated;
    for (let index = 0; index < 100; index += 1) {
      current = await service.addBill(user.id, {
        tripId: trip.id,
        date: '2026-07-10',
        expectedVersion: current.version,
        bill: {
          title: `账${index}`,
          amountCents: 1,
          participants: [{ memberId: user.id, displayName: user.displayName, shares: 1 }],
          payers: [{ memberId: user.id, displayName: user.displayName, paidCents: 1 }],
        },
      });
    }
    await expect(
      service.addBill(user.id, {
        tripId: trip.id,
        date: '2026-07-10',
        expectedVersion: current.version,
        bill: {
          title: '第一百零一笔',
          amountCents: 1,
          participants: [{ memberId: user.id, displayName: user.displayName, shares: 1 }],
          payers: [{ memberId: user.id, displayName: user.displayName, paidCents: 1 }],
        },
      }),
    ).rejects.toMatchObject({ code: 'BILL_LIMIT_REACHED' });

    const withDeleted = await service.deleteBill(user.id, {
      tripId: trip.id,
      billId: current.bills[0]!.id,
      expectedVersion: current.version,
    });
    const reused = await service.addBill(user.id, {
      tripId: trip.id,
      date: '2026-07-10',
      expectedVersion: withDeleted.version,
      bill: {
        title: '复用名额',
        amountCents: 1,
        participants: [{ memberId: user.id, displayName: user.displayName, shares: 1 }],
        payers: [{ memberId: user.id, displayName: user.displayName, paidCents: 1 }],
      },
    });
    expect(reused.bills.filter((bill) => bill.deletedAt === null)).toHaveLength(100);
  });
});
