import { beforeEach, describe, expect, it } from 'vitest';

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
    await service.deleteAccount(user, new MemorySocialRepository());

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
});
