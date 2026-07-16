import {
  DEFAULT_SIGNATURE,
  LIMITS,
  calculateSettlement,
  isValidTripName,
  validateBill,
  type BillInput,
  type SettlementResult,
} from '@travel-ledger/domain';

import { assertBusiness, BusinessError } from './errors';
import type {
  BillDocument,
  Clock,
  IdGenerator,
  TripDocument,
  TripMemberDocument,
  TripSummaryDocument,
  UserDocument,
} from './models';
import type { Repository } from './repository';

export interface CreateTripInput {
  name: string;
}

export interface AddDateInput {
  tripId: string;
  date: string;
  expectedVersion: number;
}

export interface AddBillInput {
  tripId: string;
  date: string;
  bill: BillInput;
  expectedVersion: number;
}

export interface CompleteTripInput {
  tripId: string;
  expectedVersion: number;
  ignoreInvalidBills: boolean;
}

export interface ArchiveTripInput {
  tripId: string;
  expectedVersion: number;
}

export interface ReopenTripInput {
  tripId: string;
  expectedVersion: number;
}

export interface RestoreTripInput {
  tripId: string;
  expectedVersion: number;
}

export class LedgerService {
  constructor(
    private readonly repository: Repository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async bootstrapSession(openId: string): Promise<UserDocument> {
    const existing = await this.repository.findUserByOpenId(openId);
    if (existing !== null) return existing;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const publicId = this.ids.publicId();
      if ((await this.repository.findUserByPublicId(publicId)) !== null) continue;
      const timestamp = this.clock.now().toISOString();
      const user: UserDocument = {
        id: this.ids.entityId('usr'),
        openId,
        publicId,
        displayName: `旅人${publicId.slice(-6)}`,
        signature: DEFAULT_SIGNATURE,
        avatarUrl: null,
        status: 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      try {
        await this.repository.createUser(user);
        return user;
      } catch (error: unknown) {
        if (error instanceof Error && error.message === 'DUPLICATE_USER') continue;
        throw error;
      }
    }
    throw new BusinessError('PUBLIC_ID_EXHAUSTED', '暂时无法生成公开 ID，请稍后重试。', true);
  }

  async listTrips(userId: string): Promise<readonly TripSummaryDocument[]> {
    const trips = await this.repository.listTripsForUser(userId);
    return trips
      .filter((trip) => memberFor(trip, userId).viewState === 'home')
      .map(toTripSummary)
      .sort((left, right) =>
        (left.startDate ?? '9999-99-99').localeCompare(right.startDate ?? '9999-99-99'),
      );
  }

  async listArchivedTrips(userId: string): Promise<readonly TripDocument[]> {
    const trips = await this.repository.listTripsForUser(userId);
    return trips
      .filter((trip) => memberFor(trip, userId).viewState === 'archived')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getTrip(userId: string, tripId: string): Promise<TripDocument> {
    const trip = await this.requiredTrip(tripId);
    const member = memberFor(trip, userId);
    assertBusiness(member.viewState !== 'detached', 'FORBIDDEN', '你已永久移除此行程。');
    return trip;
  }

  async createTrip(user: UserDocument, input: CreateTripInput): Promise<TripDocument> {
    const name = input.name.trim();
    assertBusiness(isValidTripName(name), 'TRIP_NAME_INVALID', '行程名称格式不正确。');
    const homeCount = await this.repository.countHomeTrips(user.id);
    assertBusiness(
      homeCount < LIMITS.activeTripsPerUser,
      'TRIP_LIMIT_REACHED',
      `首页最多保留 ${LIMITS.activeTripsPerUser} 条行程。`,
    );

    const timestamp = this.clock.now().toISOString();
    const member: TripMemberDocument = {
      userId: user.id,
      displayNameSnapshot: user.displayName,
      joinedAt: timestamp,
      viewState: 'home',
      archivedAt: null,
      purgeAfter: null,
    };
    const trip: TripDocument = {
      id: this.ids.entityId('trp'),
      name,
      status: 'active',
      memberIds: [user.id],
      members: [member],
      dates: [],
      bills: [],
      totalCents: 0,
      invalidBillCount: 0,
      version: 1,
      ledgerRevision: 0,
      createdBy: user.id,
      createdAt: timestamp,
      updatedBy: user.id,
      updatedAt: timestamp,
      completedAt: null,
      completedBy: null,
    };
    await this.repository.createTrip(trip);
    return trip;
  }

  async addDate(userId: string, input: AddDateInput): Promise<TripDocument> {
    assertCalendarDate(input.date);
    const trip = await this.editableTrip(userId, input.tripId, input.expectedVersion);
    assertBusiness(!trip.dates.includes(input.date), 'DATE_ALREADY_EXISTS', '该日期已经存在。');

    return this.saveTrip(trip, userId, {
      dates: [...trip.dates, input.date].sort(),
      ledgerRevision: trip.ledgerRevision + 1,
    });
  }

  async addBill(userId: string, input: AddBillInput): Promise<TripDocument> {
    assertCalendarDate(input.date);
    const trip = await this.editableTrip(userId, input.tripId, input.expectedVersion);
    assertBusiness(trip.dates.includes(input.date), 'DATE_NOT_FOUND', '请先添加账单所属日期。');
    assertBusiness(
      activeBills(trip).length < LIMITS.billsPerTrip,
      'BILL_LIMIT_REACHED',
      `每段行程最多保留 ${LIMITS.billsPerTrip} 条账单。`,
    );
    const memberIds = new Set(trip.memberIds);
    for (const participant of input.bill.participants) {
      assertBusiness(
        memberIds.has(participant.memberId),
        'MEMBER_NOT_IN_TRIP',
        '参与人不在当前行程中。',
      );
    }
    for (const payer of input.bill.payers) {
      assertBusiness(memberIds.has(payer.memberId), 'MEMBER_NOT_IN_TRIP', '付款人不在当前行程中。');
    }

    const validationCodes = validateBill(input.bill).map((issue) => issue.code);
    const coreCodes = new Set([
      'TITLE_REQUIRED',
      'TITLE_TOO_LONG',
      'TITLE_HAS_CONTROL_CHARACTER',
      'AMOUNT_INVALID',
      'PARTICIPANTS_REQUIRED',
      'PARTICIPANT_DUPLICATE',
      'PARTICIPANT_SHARE_INVALID',
      'PAYERS_REQUIRED',
      'PAYER_DUPLICATE',
      'PAYER_AMOUNT_INVALID',
    ]);
    assertBusiness(
      !validationCodes.some((code) => coreCodes.has(code)),
      'BILL_CORE_INVALID',
      '账单核心字段不完整或格式不正确。',
      { validationCodes },
    );

    const timestamp = this.clock.now().toISOString();
    const bill: BillDocument = {
      ...structuredClone(input.bill),
      id: this.ids.entityId('bil'),
      date: input.date,
      validationCodes,
      createdBy: userId,
      createdAt: timestamp,
      updatedBy: userId,
      updatedAt: timestamp,
      deletedAt: null,
      deletedBy: null,
    };
    return this.saveTrip(trip, userId, {
      bills: [...trip.bills, bill],
      totalCents: trip.totalCents + bill.amountCents,
      invalidBillCount: trip.invalidBillCount + (validationCodes.length > 0 ? 1 : 0),
      ledgerRevision: trip.ledgerRevision + 1,
    });
  }

  async calculate(
    userId: string,
    tripId: string,
  ): Promise<{
    result: SettlementResult;
    ignoredBillIds: readonly string[];
    includedCents: number;
    ledgerRevision: number;
  }> {
    const trip = await this.getTrip(userId, tripId);
    const bills = activeBills(trip);
    const valid = bills.filter((bill) => bill.validationCodes.length === 0);
    const ignored = bills.filter((bill) => bill.validationCodes.length > 0);
    return {
      result: calculateSettlement(valid),
      ignoredBillIds: ignored.map((bill) => bill.id),
      includedCents: valid.reduce((sum, bill) => sum + bill.amountCents, 0),
      ledgerRevision: trip.ledgerRevision,
    };
  }

  async completeTrip(userId: string, input: CompleteTripInput): Promise<TripDocument> {
    const trip = await this.editableTrip(userId, input.tripId, input.expectedVersion);
    assertBusiness(
      input.ignoreInvalidBills || trip.invalidBillCount === 0,
      'INVALID_BILLS_REQUIRE_CONFIRMATION',
      '仍有分配无效的账单，请修改或明确忽略后再完结。',
    );
    const timestamp = this.clock.now().toISOString();
    return this.saveTrip(trip, userId, {
      status: 'completed',
      completedAt: timestamp,
      completedBy: userId,
    });
  }

  async reopenTrip(userId: string, input: ReopenTripInput): Promise<TripDocument> {
    const trip = await this.versionedTrip(userId, input.tripId, input.expectedVersion);
    assertBusiness(trip.status === 'completed', 'TRIP_NOT_COMPLETED', '该行程尚未完结。');
    for (const member of trip.members) {
      if (member.viewState === 'home') {
        const homeCount = await this.repository.countHomeTrips(member.userId);
        assertBusiness(
          homeCount <= LIMITS.activeTripsPerUser,
          'MEMBER_TRIP_LIMIT_REACHED',
          '有同行人的首页已满，暂时无法重新开启。',
          { memberId: member.userId },
        );
      }
    }
    return this.saveTrip(trip, userId, {
      status: 'active',
      completedAt: null,
      completedBy: null,
    });
  }

  async archiveTrip(userId: string, input: ArchiveTripInput): Promise<TripDocument> {
    const trip = await this.versionedTrip(userId, input.tripId, input.expectedVersion);
    assertBusiness(trip.status === 'completed', 'TRIP_NOT_COMPLETED', '只有已完结行程可以归档。');
    const now = this.clock.now();
    const members = trip.members.map((member) =>
      member.userId === userId
        ? {
            ...member,
            viewState: 'archived' as const,
            archivedAt: now.toISOString(),
            purgeAfter: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          }
        : member,
    );
    return this.saveTrip(trip, userId, { members });
  }

  async restoreTrip(userId: string, input: RestoreTripInput): Promise<TripDocument> {
    const trip = await this.versionedTrip(userId, input.tripId, input.expectedVersion);
    const member = memberFor(trip, userId);
    assertBusiness(
      member.viewState === 'archived',
      'TRIP_NOT_ARCHIVED',
      '该行程不在已完结行程中。',
    );
    const homeCount = await this.repository.countHomeTrips(userId);
    assertBusiness(
      homeCount < LIMITS.activeTripsPerUser,
      'TRIP_LIMIT_REACHED',
      `首页最多保留 ${LIMITS.activeTripsPerUser} 条行程。`,
    );
    const members = trip.members.map((item) =>
      item.userId === userId
        ? { ...item, viewState: 'home' as const, archivedAt: null, purgeAfter: null }
        : item,
    );
    return this.saveTrip(trip, userId, { members });
  }

  private async editableTrip(userId: string, tripId: string, expectedVersion: number) {
    const trip = await this.versionedTrip(userId, tripId, expectedVersion);
    assertBusiness(trip.status === 'active', 'TRIP_COMPLETED', '已完结行程当前为只读。');
    assertBusiness(
      memberFor(trip, userId).viewState === 'home',
      'TRIP_NOT_IN_HOME',
      '请先恢复该行程。',
    );
    return trip;
  }

  private async versionedTrip(userId: string, tripId: string, expectedVersion: number) {
    const trip = await this.getTrip(userId, tripId);
    assertBusiness(
      trip.version === expectedVersion,
      'VERSION_CONFLICT',
      '行程已被其他成员修改，请刷新后重试。',
      { currentVersion: trip.version },
    );
    return trip;
  }

  private async requiredTrip(tripId: string) {
    const trip = await this.repository.getTrip(tripId);
    assertBusiness(trip !== null, 'TRIP_NOT_FOUND', '找不到该行程。');
    return trip;
  }

  private async saveTrip(
    trip: TripDocument,
    userId: string,
    changes: Partial<TripDocument>,
  ): Promise<TripDocument> {
    const next: TripDocument = {
      ...trip,
      ...changes,
      version: trip.version + 1,
      updatedBy: userId,
      updatedAt: this.clock.now().toISOString(),
    };
    const replaced = await this.repository.replaceTrip(next, trip.version);
    if (!replaced) {
      throw new BusinessError('VERSION_CONFLICT', '行程已被其他成员修改，请刷新后重试。');
    }
    return next;
  }
}

function memberFor(trip: TripDocument, userId: string): TripMemberDocument {
  const member = trip.members.find((item) => item.userId === userId);
  assertBusiness(member !== undefined, 'FORBIDDEN', '你不是该行程的成员。');
  return member;
}

function activeBills(trip: TripDocument) {
  return trip.bills.filter((bill) => bill.deletedAt === null);
}

function toTripSummary(trip: TripDocument): TripSummaryDocument {
  const dates = [...trip.dates].sort();
  return {
    id: trip.id,
    name: trip.name,
    status: trip.status,
    startDate: dates[0] ?? null,
    endDate: dates.at(-1) ?? null,
    totalCents: trip.totalCents,
    invalidBillCount: trip.invalidBillCount,
    ledgerRevision: trip.ledgerRevision,
  };
}

function assertCalendarDate(value: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  assertBusiness(match !== null, 'DATE_INVALID', '日期格式必须为 YYYY-MM-DD。');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalized = new Date(Date.UTC(year, month - 1, day));
  assertBusiness(
    normalized.getUTCFullYear() === year &&
      normalized.getUTCMonth() === month - 1 &&
      normalized.getUTCDate() === day,
    'DATE_INVALID',
    '请选择真实存在的日期。',
  );
}
