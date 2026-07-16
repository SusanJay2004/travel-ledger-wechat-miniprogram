export interface MaintenanceMember {
  viewState: 'home' | 'archived' | 'detached';
  archivedAt: string | null;
  purgeAfter: string | null;
}

export interface MaintenanceBill {
  deletedAt: string | null;
}

export interface MaintenanceTrip<TMember extends MaintenanceMember, TBill extends MaintenanceBill> {
  members: readonly TMember[];
  bills: readonly TBill[];
  version: number;
}

export interface TripCleanupResult<
  TMember extends MaintenanceMember,
  TBill extends MaintenanceBill,
> {
  changed: boolean;
  orphaned: boolean;
  members: readonly TMember[];
  bills: readonly TBill[];
  purgedBillCount: number;
  detachedMemberCount: number;
}

export function cleanTrip<TMember extends MaintenanceMember, TBill extends MaintenanceBill>(
  trip: MaintenanceTrip<TMember, TBill>,
  now: Date,
  billRetentionMs = 30 * 24 * 60 * 60 * 1000,
): TripCleanupResult<TMember, TBill> {
  let detachedMemberCount = 0;
  const members = trip.members.map((member) => {
    if (
      member.viewState !== 'archived' ||
      member.purgeAfter === null ||
      new Date(member.purgeAfter).getTime() > now.getTime()
    ) {
      return member;
    }
    detachedMemberCount += 1;
    return {
      ...member,
      viewState: 'detached' as const,
      archivedAt: null,
      purgeAfter: null,
    };
  });

  const bills = trip.bills.filter((bill) => {
    if (bill.deletedAt === null) return true;
    const deletedAt = new Date(bill.deletedAt).getTime();
    return !Number.isFinite(deletedAt) || now.getTime() - deletedAt < billRetentionMs;
  });
  const purgedBillCount = trip.bills.length - bills.length;
  return {
    bills,
    changed: detachedMemberCount > 0 || purgedBillCount > 0,
    detachedMemberCount,
    members,
    orphaned: members.every((member) => member.viewState === 'detached'),
    purgedBillCount,
  };
}
