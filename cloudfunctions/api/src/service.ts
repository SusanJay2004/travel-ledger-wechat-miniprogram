import {
  DEFAULT_SIGNATURE,
  LIMITS,
  calculateSettlement,
  isValidTripName,
  isValidSignature,
  isValidUsername,
  validateBill,
  type BillInput,
  type SettlementResult,
} from '@travel-ledger/domain';

import { assertBusiness, BusinessError } from './errors';
import { disabledContentSecurity, type ContentSecurity } from './content-security';
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
import type { SocialRepository } from './social-repository';

export interface TripChangePublisher {
  prepareTripCreated(after: TripDocument, actorUserId: string): TripDocument;
  prepareTripChange(
    before: TripDocument,
    after: TripDocument,
    action: string,
    actorUserId: string,
    entityType: 'trip' | 'date' | 'bill' | 'member',
    entityId: string,
  ): TripDocument;
  publishTripCreated(after: TripDocument, actorUserId: string): Promise<void>;
  publishTripChange(
    before: TripDocument,
    after: TripDocument,
    action: string,
    actorUserId: string,
    entityType: 'trip' | 'date' | 'bill' | 'member',
    entityId: string,
  ): Promise<void>;
}

const noopPublisher: TripChangePublisher = {
  prepareTripCreated: (after) => after,
  prepareTripChange: (_before, after) => after,
  publishTripCreated: async () => undefined,
  publishTripChange: async () => undefined,
};

export interface CreateTripInput {
  name: string;
}

export interface AddDateInput {
  tripId: string;
  date: string;
  expectedVersion: number;
}

export type DeleteDateInput = AddDateInput;

export interface AddBillInput {
  tripId: string;
  date: string;
  bill: BillInput;
  expectedVersion: number;
}

export interface UpdateProfileInput {
  displayName: string;
  signature: string;
  avatarUrl: string | null;
}

export interface RenameTripInput {
  tripId: string;
  name: string;
  expectedVersion: number;
}

export interface UpdateBillInput extends AddBillInput {
  billId: string;
}

export interface BillMutationInput {
  tripId: string;
  billId: string;
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

export interface RemoveArchivedTripInput {
  tripId: string;
  expectedVersion: number;
}

export class LedgerService {
  constructor(
    private readonly repository: Repository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly publisher: TripChangePublisher = noopPublisher,
    private readonly contentSecurity: ContentSecurity = disabledContentSecurity(),
  ) {}

  async bootstrapSession(openId: string): Promise<UserDocument> {
    const existing = await this.repository.findUserByOpenId(openId);
    if (existing !== null && existing.status === 'active') return existing;
    if (existing?.status === 'deleting') {
      throw new BusinessError('ACCOUNT_DELETION_PENDING', '账号正在注销，请稍后重新进入。', true);
    }

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
        qrCodeFileId: null,
        qrSceneToken: null,
        homeTripCount: 0,
        status: 'active',
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      try {
        await this.repository.createUser(user);
        return user;
      } catch (error: unknown) {
        if (error instanceof Error && error.message === 'DUPLICATE_USER') {
          const raced = await this.repository.findUserByOpenId(openId);
          if (raced?.status === 'active') return raced;
          continue;
        }
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

  async updateProfile(user: UserDocument, input: UpdateProfileInput): Promise<UserDocument> {
    const displayName = input.displayName.trim();
    const signature = input.signature.trim() || DEFAULT_SIGNATURE;
    assertBusiness(isValidUsername(displayName), 'USERNAME_INVALID', '用户名格式不正确。');
    assertBusiness(isValidSignature(signature), 'SIGNATURE_INVALID', '个人签名格式不正确。');
    assertBusiness(
      input.avatarUrl === null || input.avatarUrl.length <= 512,
      'AVATAR_URL_INVALID',
      '头像地址格式不正确。',
    );
    assertBusiness(
      input.avatarUrl === null || avatarBelongsToUser(input.avatarUrl, user.id),
      'AVATAR_OWNERSHIP_INVALID',
      '只能使用当前账号上传的头像。',
    );
    await this.contentSecurity.checkText(user.openId, 2, displayName, signature);
    if (input.avatarUrl !== null && input.avatarUrl !== user.avatarUrl) {
      await this.contentSecurity.checkImage(user.openId, input.avatarUrl);
    }
    const next: UserDocument = {
      ...user,
      displayName,
      signature,
      avatarUrl: input.avatarUrl,
      version: user.version + 1,
      updatedAt: this.clock.now().toISOString(),
    };
    const updated = await this.repository.updateUser(next, user.version);
    if (!updated)
      throw new BusinessError(
        'PROFILE_VERSION_CONFLICT',
        '个人资料刚刚发生变化，请刷新后重试。',
        true,
      );
    return next;
  }

  async deleteAccount(user: UserDocument, social: SocialRepository): Promise<void> {
    const deleting: UserDocument =
      user.status === 'deleting'
        ? user
        : {
            ...user,
            displayName: '已注销用户',
            signature: DEFAULT_SIGNATURE,
            avatarUrl: null,
            qrCodeFileId: null,
            qrSceneToken: null,
            pendingFileDeletionIds: accountFileIds(user),
            status: 'deleting',
            version: user.version + 1,
            updatedAt: this.clock.now().toISOString(),
          };
    if (user.status !== 'deleting') {
      const marked = await this.repository.updateUser(deleting, user.version);
      if (!marked) {
        throw new BusinessError(
          'PROFILE_VERSION_CONFLICT',
          '账号资料刚刚发生变化，请重新确认注销。',
          true,
        );
      }
    }

    const trips = await this.repository.listTripsForUser(user.id);
    for (const trip of trips) {
      const next: TripDocument = {
        ...trip,
        members: trip.members.map((member) =>
          member.userId === user.id
            ? {
                ...member,
                displayNameSnapshot: '已注销用户',
                viewState: 'detached' as const,
                archivedAt: null,
                purgeAfter: null,
              }
            : member,
        ),
        bills: trip.bills.map((bill) => ({
          ...bill,
          participants: bill.participants.map((participant) =>
            participant.memberId === user.id
              ? { ...participant, displayName: '已注销用户' }
              : participant,
          ),
          payers: bill.payers.map((payer) =>
            payer.memberId === user.id ? { ...payer, displayName: '已注销用户' } : payer,
          ),
        })),
        version: trip.version + 1,
        ledgerRevision: trip.ledgerRevision + 1,
        settlementCache: null,
        updatedBy: user.id,
        updatedAt: this.clock.now().toISOString(),
      };
      const currentMember = trip.members.find((member) => member.userId === user.id);
      if (
        currentMember?.viewState === 'detached' &&
        currentMember.displayNameSnapshot === '已注销用户'
      ) {
        continue;
      }
      const prepared = this.publisher.prepareTripChange(
        trip,
        next,
        'member.account_deleted',
        user.id,
        'member',
        user.id,
      );
      const replaced = await this.repository.replaceTrip(prepared, trip.version);
      if (!replaced) {
        throw new BusinessError('VERSION_CONFLICT', '有行程正在被修改，请稍后重新确认注销。', true);
      }
      await this.publisher.publishTripChange(
        trip,
        prepared,
        'member.account_deleted',
        user.id,
        'member',
        user.id,
      );
    }
    await social.purgeUserData(user.id);
    const deleted = await this.repository.updateUser(
      {
        ...deleting,
        openId: `deleted:${user.id}`,
        publicId: `DEL${user.id.slice(-7).toUpperCase()}`,
        homeTripCount: 0,
        status: 'deleted',
        version: deleting.version + 1,
      },
      deleting.version,
    );
    if (!deleted) {
      throw new BusinessError(
        'PROFILE_VERSION_CONFLICT',
        '账号注销状态发生变化，请稍后重试。',
        true,
      );
    }
  }

  async listArchivedTrips(userId: string): Promise<readonly TripDocument[]> {
    const trips = await this.repository.listTripsForUser(userId);
    return trips
      .filter((trip) => {
        const member = memberFor(trip, userId);
        return (
          member.viewState === 'archived' &&
          member.purgeAfter !== null &&
          new Date(member.purgeAfter).getTime() > this.clock.now().getTime()
        );
      })
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
    await this.contentSecurity.checkText(user.openId, 3, name);
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
    const prepared = this.publisher.prepareTripCreated(trip, user.id);
    const saved = await this.repository.createTripWithHomeCapacity(
      prepared,
      user.id,
      LIMITS.activeTripsPerUser,
    );
    if (saved === 'user_inactive') {
      throw new BusinessError('ACCOUNT_DELETION_PENDING', '账号正在注销，不能再创建行程。', true);
    }
    assertBusiness(
      saved === 'saved',
      'TRIP_LIMIT_REACHED',
      `首页最多保留 ${LIMITS.activeTripsPerUser} 条行程。`,
    );
    await this.publisher.publishTripCreated(prepared, user.id);
    return prepared;
  }

  async renameTrip(userId: string, input: RenameTripInput): Promise<TripDocument> {
    const name = input.name.trim();
    assertBusiness(isValidTripName(name), 'TRIP_NAME_INVALID', '行程名称格式不正确。');
    const trip = await this.editableTrip(userId, input.tripId, input.expectedVersion);
    await this.checkTextForUser(userId, 3, name);
    return this.saveTrip(trip, userId, { name }, 'trip.renamed', 'trip', trip.id);
  }

  async addDate(userId: string, input: AddDateInput): Promise<TripDocument> {
    assertCalendarDate(input.date);
    const trip = await this.editableTrip(userId, input.tripId, input.expectedVersion);
    assertBusiness(!trip.dates.includes(input.date), 'DATE_ALREADY_EXISTS', '该日期已经存在。');

    return this.saveTrip(
      trip,
      userId,
      {
        dates: [...trip.dates, input.date].sort(),
        ledgerRevision: trip.ledgerRevision + 1,
      },
      'date.created',
      'date',
      input.date,
    );
  }

  async deleteDate(userId: string, input: DeleteDateInput): Promise<TripDocument> {
    assertCalendarDate(input.date);
    const trip = await this.editableTrip(userId, input.tripId, input.expectedVersion);
    assertBusiness(trip.dates.includes(input.date), 'DATE_NOT_FOUND', '找不到这个日期。');
    const activeBillCount = trip.bills.filter(
      (bill) => bill.date === input.date && bill.deletedAt === null,
    ).length;
    assertBusiness(activeBillCount === 0, 'DATE_HAS_BILLS', '请先移动或删除该日期下的有效账单。', {
      activeBillCount,
    });

    return this.saveTrip(
      trip,
      userId,
      {
        dates: trip.dates.filter((date) => date !== input.date),
        ledgerRevision: trip.ledgerRevision + 1,
      },
      'date.deleted',
      'date',
      input.date,
    );
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
    const retainedBills = retainRestorableBills(trip, this.clock.now());
    assertBusiness(
      retainedBills.length < LIMITS.retainedBillsPerTrip,
      'BILL_HISTORY_LIMIT_REACHED',
      '近期删除记录较多，请等待满 30 天自动清理后再新增账单。',
    );
    const normalizedBill = billWithTrustedMemberNames(trip, input.bill);
    const validationCodes = validateBillForTrip(trip, normalizedBill);
    await this.checkTextForUser(userId, 3, input.bill.title);

    const timestamp = this.clock.now().toISOString();
    const bill: BillDocument = {
      ...normalizedBill,
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
    return this.saveTrip(
      trip,
      userId,
      {
        bills: [...retainedBills, bill],
        totalCents: trip.totalCents + bill.amountCents,
        invalidBillCount: trip.invalidBillCount + (validationCodes.length > 0 ? 1 : 0),
        ledgerRevision: trip.ledgerRevision + 1,
      },
      'bill.created',
      'bill',
      bill.id,
    );
  }

  async updateBill(userId: string, input: UpdateBillInput): Promise<TripDocument> {
    assertCalendarDate(input.date);
    const trip = await this.editableTrip(userId, input.tripId, input.expectedVersion);
    assertBusiness(trip.dates.includes(input.date), 'DATE_NOT_FOUND', '请先添加账单所属日期。');
    const existing = requiredBill(trip, input.billId);
    assertBusiness(existing.deletedAt === null, 'BILL_DELETED', '已删除账单不能直接修改。');
    const normalizedBill = billWithTrustedMemberNames(trip, input.bill);
    const validationCodes = validateBillForTrip(trip, normalizedBill, existing);
    await this.checkTextForUser(userId, 3, input.bill.title);
    const timestamp = this.clock.now().toISOString();
    const replacement: BillDocument = {
      ...normalizedBill,
      id: existing.id,
      date: input.date,
      validationCodes,
      createdBy: existing.createdBy,
      createdAt: existing.createdAt,
      updatedBy: userId,
      updatedAt: timestamp,
      deletedAt: null,
      deletedBy: null,
    };
    const bills = trip.bills.map((bill) => (bill.id === existing.id ? replacement : bill));
    return this.saveTrip(
      trip,
      userId,
      {
        bills,
        totalCents: trip.totalCents - existing.amountCents + replacement.amountCents,
        invalidBillCount:
          trip.invalidBillCount -
          (existing.validationCodes.length > 0 ? 1 : 0) +
          (replacement.validationCodes.length > 0 ? 1 : 0),
        ledgerRevision: trip.ledgerRevision + 1,
      },
      'bill.updated',
      'bill',
      existing.id,
    );
  }

  async deleteBill(userId: string, input: BillMutationInput): Promise<TripDocument> {
    const trip = await this.editableTrip(userId, input.tripId, input.expectedVersion);
    const existing = requiredBill(trip, input.billId);
    assertBusiness(existing.deletedAt === null, 'BILL_ALREADY_DELETED', '该账单已经删除。');
    const timestamp = this.clock.now().toISOString();
    const bills = trip.bills.map((bill) =>
      bill.id === existing.id
        ? {
            ...bill,
            deletedAt: timestamp,
            deletedBy: userId,
            updatedAt: timestamp,
            updatedBy: userId,
          }
        : bill,
    );
    return this.saveTrip(
      trip,
      userId,
      {
        bills,
        totalCents: trip.totalCents - existing.amountCents,
        invalidBillCount: trip.invalidBillCount - (existing.validationCodes.length > 0 ? 1 : 0),
        ledgerRevision: trip.ledgerRevision + 1,
      },
      'bill.deleted',
      'bill',
      existing.id,
    );
  }

  async restoreBill(userId: string, input: BillMutationInput): Promise<TripDocument> {
    const trip = await this.editableTrip(userId, input.tripId, input.expectedVersion);
    const existing = requiredBill(trip, input.billId);
    assertBusiness(existing.deletedAt !== null, 'BILL_NOT_DELETED', '该账单没有被删除。');
    const deletedAt = new Date(existing.deletedAt).getTime();
    assertBusiness(
      Number.isFinite(deletedAt) &&
        this.clock.now().getTime() - deletedAt < 30 * 24 * 60 * 60 * 1000,
      'BILL_RESTORE_EXPIRED',
      '该账单已超过 30 天恢复期。',
    );
    assertBusiness(
      activeBills(trip).length < LIMITS.billsPerTrip,
      'BILL_LIMIT_REACHED',
      `每段行程最多保留 ${LIMITS.billsPerTrip} 条账单。`,
    );
    const timestamp = this.clock.now().toISOString();
    const bills = trip.bills.map((bill) =>
      bill.id === existing.id
        ? { ...bill, deletedAt: null, deletedBy: null, updatedAt: timestamp, updatedBy: userId }
        : bill,
    );
    return this.saveTrip(
      trip,
      userId,
      {
        dates: trip.dates.includes(existing.date)
          ? trip.dates
          : [...trip.dates, existing.date].sort(),
        bills,
        totalCents: trip.totalCents + existing.amountCents,
        invalidBillCount: trip.invalidBillCount + (existing.validationCodes.length > 0 ? 1 : 0),
        ledgerRevision: trip.ledgerRevision + 1,
      },
      'bill.restored',
      'bill',
      existing.id,
    );
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
    if (trip.settlementCache?.ledgerRevision === trip.ledgerRevision) {
      return {
        result: structuredClone(trip.settlementCache.result),
        ignoredBillIds: [...trip.settlementCache.ignoredBillIds],
        includedCents: trip.settlementCache.includedCents,
        ledgerRevision: trip.settlementCache.ledgerRevision,
      };
    }
    const bills = activeBills(trip);
    const valid = bills.filter((bill) => bill.validationCodes.length === 0);
    const ignored = bills.filter((bill) => bill.validationCodes.length > 0);
    const calculated = {
      result: calculateSettlement(valid),
      ignoredBillIds: ignored.map((bill) => bill.id),
      includedCents: valid.reduce((sum, bill) => sum + bill.amountCents, 0),
      ledgerRevision: trip.ledgerRevision,
    };
    const cached: TripDocument = {
      ...trip,
      settlementCache: {
        ...calculated,
        calculatedAt: this.clock.now().toISOString(),
      },
    };
    await this.repository.replaceTrip(cached, trip.version).catch(() => false);
    return calculated;
  }

  async completeTrip(userId: string, input: CompleteTripInput): Promise<TripDocument> {
    const trip = await this.editableTrip(userId, input.tripId, input.expectedVersion);
    assertBusiness(
      input.ignoreInvalidBills || trip.invalidBillCount === 0,
      'INVALID_BILLS_REQUIRE_CONFIRMATION',
      '仍有分配无效的账单，请修改或明确忽略后再完结。',
    );
    const bills = activeBills(trip);
    const valid = bills.filter((bill) => bill.validationCodes.length === 0);
    const ignored = bills.filter((bill) => bill.validationCodes.length > 0);
    const timestamp = this.clock.now().toISOString();
    return this.saveTrip(
      trip,
      userId,
      {
        status: 'completed',
        completedAt: timestamp,
        completedBy: userId,
        settlementCache: {
          result: calculateSettlement(valid),
          ignoredBillIds: ignored.map((bill) => bill.id),
          includedCents: valid.reduce((sum, bill) => sum + bill.amountCents, 0),
          ledgerRevision: trip.ledgerRevision + 1,
          calculatedAt: timestamp,
        },
      },
      'trip.completed',
      'trip',
      trip.id,
    );
  }

  async reopenTrip(userId: string, input: ReopenTripInput): Promise<TripDocument> {
    const trip = await this.versionedTrip(userId, input.tripId, input.expectedVersion);
    assertBusiness(trip.status === 'completed', 'TRIP_NOT_COMPLETED', '该行程尚未完结。');
    const members = trip.members.map((member) =>
      member.viewState === 'archived'
        ? { ...member, viewState: 'home' as const, archivedAt: null, purgeAfter: null }
        : member,
    );
    return this.saveTripWithHomeCapacity(
      trip,
      userId,
      {
        status: 'active',
        members,
        completedAt: null,
        completedBy: null,
      },
      'trip.reopened',
      'trip',
      trip.id,
      Object.fromEntries(
        trip.members
          .filter((member) => member.viewState === 'archived')
          .map((member) => [member.userId, 1]),
      ),
      'MEMBER_TRIP_LIMIT_REACHED',
      '有同行人的首页已满，暂时无法重新开启。',
    );
  }

  async archiveTrip(userId: string, input: ArchiveTripInput): Promise<TripDocument> {
    const trip = await this.versionedTrip(userId, input.tripId, input.expectedVersion);
    assertBusiness(trip.status === 'completed', 'TRIP_NOT_COMPLETED', '只有已完结行程可以归档。');
    assertBusiness(
      memberFor(trip, userId).viewState === 'home',
      'TRIP_NOT_IN_HOME',
      '该行程已经归档。',
    );
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
    return this.saveTripWithHomeCapacity(
      trip,
      userId,
      { members },
      'member.archived',
      'member',
      userId,
      { [userId]: -1 },
      'TRIP_LIMIT_REACHED',
      `首页最多保留 ${LIMITS.activeTripsPerUser} 条行程。`,
    );
  }

  async restoreTrip(userId: string, input: RestoreTripInput): Promise<TripDocument> {
    const trip = await this.versionedTrip(userId, input.tripId, input.expectedVersion);
    const member = memberFor(trip, userId);
    assertBusiness(
      member.viewState === 'archived',
      'TRIP_NOT_ARCHIVED',
      '该行程不在已完结行程中。',
    );
    assertBusiness(
      member.purgeAfter !== null &&
        new Date(member.purgeAfter).getTime() > this.clock.now().getTime(),
      'TRIP_RESTORE_EXPIRED',
      '该行程已超过 30 天恢复期。',
    );
    const members = trip.members.map((item) =>
      item.userId === userId
        ? { ...item, viewState: 'home' as const, archivedAt: null, purgeAfter: null }
        : item,
    );
    return this.saveTripWithHomeCapacity(
      trip,
      userId,
      { members },
      'member.restored',
      'member',
      userId,
      { [userId]: 1 },
      'TRIP_LIMIT_REACHED',
      `首页最多保留 ${LIMITS.activeTripsPerUser} 条行程。`,
    );
  }

  async removeArchivedTrip(userId: string, input: RemoveArchivedTripInput): Promise<TripDocument> {
    const trip = await this.versionedTrip(userId, input.tripId, input.expectedVersion);
    const member = memberFor(trip, userId);
    assertBusiness(
      member.viewState === 'archived',
      'TRIP_NOT_ARCHIVED',
      '只有已归档行程可以永久移除。',
    );
    const members = trip.members.map((item) =>
      item.userId === userId
        ? {
            ...item,
            viewState: 'detached' as const,
            archivedAt: null,
            purgeAfter: null,
          }
        : item,
    );
    return this.saveTrip(trip, userId, { members }, 'member.detached', 'member', userId);
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

  private async checkTextForUser(userId: string, scene: number, ...values: string[]) {
    const user = await this.repository.getUser(userId);
    assertBusiness(user !== null && user.status === 'active', 'USER_NOT_FOUND', '找不到当前用户。');
    await this.contentSecurity.checkText(user.openId, scene, ...values);
  }

  private async saveTrip(
    trip: TripDocument,
    userId: string,
    changes: Partial<TripDocument>,
    action: string,
    entityType: 'trip' | 'date' | 'bill' | 'member',
    entityId: string,
  ): Promise<TripDocument> {
    const next: TripDocument = {
      ...trip,
      ...changes,
      ledgerRevision: changes.ledgerRevision ?? trip.ledgerRevision + 1,
      ...(changes.settlementCache === undefined ? { settlementCache: null } : {}),
      version: trip.version + 1,
      updatedBy: userId,
      updatedAt: this.clock.now().toISOString(),
    };
    const prepared = this.publisher.prepareTripChange(
      trip,
      next,
      action,
      userId,
      entityType,
      entityId,
    );
    const replaced = await this.repository.replaceTrip(prepared, trip.version);
    if (!replaced) {
      throw new BusinessError('VERSION_CONFLICT', '行程已被其他成员修改，请刷新后重试。');
    }
    await this.publisher.publishTripChange(trip, prepared, action, userId, entityType, entityId);
    return prepared;
  }

  private async saveTripWithHomeCapacity(
    trip: TripDocument,
    userId: string,
    changes: Partial<TripDocument>,
    action: string,
    entityType: 'trip' | 'date' | 'bill' | 'member',
    entityId: string,
    homeCountDeltas: Readonly<Record<string, number>>,
    capacityErrorCode: string,
    capacityErrorMessage: string,
  ): Promise<TripDocument> {
    const next: TripDocument = {
      ...trip,
      ...changes,
      ledgerRevision: changes.ledgerRevision ?? trip.ledgerRevision + 1,
      ...(changes.settlementCache === undefined ? { settlementCache: null } : {}),
      version: trip.version + 1,
      updatedBy: userId,
      updatedAt: this.clock.now().toISOString(),
    };
    const prepared = this.publisher.prepareTripChange(
      trip,
      next,
      action,
      userId,
      entityType,
      entityId,
    );
    const saved = await this.repository.replaceTripWithHomeCapacity(
      prepared,
      trip.version,
      homeCountDeltas,
      LIMITS.activeTripsPerUser,
    );
    if (saved === 'capacity_exceeded') {
      throw new BusinessError(capacityErrorCode, capacityErrorMessage, false, {
        memberIds: Object.keys(homeCountDeltas).filter(
          (memberId) => homeCountDeltas[memberId]! > 0,
        ),
      });
    }
    if (saved === 'user_inactive') {
      throw new BusinessError('ACCOUNT_DELETION_PENDING', '账号正在注销，不能再修改行程。', true);
    }
    if (saved === 'version_conflict') {
      throw new BusinessError('VERSION_CONFLICT', '行程已被其他成员修改，请刷新后重试。');
    }
    await this.publisher.publishTripChange(trip, prepared, action, userId, entityType, entityId);
    return prepared;
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

function retainRestorableBills(trip: TripDocument, now: Date): readonly BillDocument[] {
  const retentionMs = 30 * 24 * 60 * 60 * 1000;
  return trip.bills.filter((bill) => {
    if (bill.deletedAt === null) return true;
    const deletedAt = new Date(bill.deletedAt).getTime();
    return !Number.isFinite(deletedAt) || now.getTime() - deletedAt < retentionMs;
  });
}

function requiredBill(trip: TripDocument, billId: string): BillDocument {
  const bill = trip.bills.find((item) => item.id === billId);
  assertBusiness(bill !== undefined, 'BILL_NOT_FOUND', '找不到该账单。');
  return bill;
}

function validateBillForTrip(trip: TripDocument, bill: BillInput, existing?: BillDocument) {
  assertBusiness(
    bill.participants.length <= LIMITS.membersPerTrip &&
      bill.payers.length <= LIMITS.membersPerTrip,
    'BILL_CORE_INVALID',
    `参与人和付款人均不能超过 ${LIMITS.membersPerTrip} 人。`,
  );
  const memberIds = new Set(
    trip.members.filter((member) => member.viewState === 'home').map((member) => member.userId),
  );
  for (const participant of existing?.participants ?? []) memberIds.add(participant.memberId);
  for (const payer of existing?.payers ?? []) memberIds.add(payer.memberId);
  for (const participant of bill.participants) {
    assertBusiness(
      memberIds.has(participant.memberId),
      'MEMBER_NOT_IN_TRIP',
      '参与人不在当前行程中。',
    );
  }
  for (const payer of bill.payers) {
    assertBusiness(memberIds.has(payer.memberId), 'MEMBER_NOT_IN_TRIP', '付款人不在当前行程中。');
  }
  const validationCodes = validateBill(bill).map((issue) => issue.code);
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
  return validationCodes;
}

function billWithTrustedMemberNames(trip: TripDocument, bill: BillInput): BillInput {
  const names = new Map(trip.members.map((member) => [member.userId, member.displayNameSnapshot]));
  return {
    title: bill.title.trim(),
    amountCents: bill.amountCents,
    participants: bill.participants.map((participant) => ({
      memberId: participant.memberId,
      displayName: names.get(participant.memberId) ?? '',
      shares: participant.shares,
    })),
    payers: bill.payers.map((payer) => ({
      memberId: payer.memberId,
      displayName: names.get(payer.memberId) ?? '',
      paidCents: payer.paidCents,
    })),
  };
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

function avatarBelongsToUser(fileId: string, userId: string): boolean {
  if (!fileId.startsWith('cloud://')) return false;
  const cloudPath = fileId.slice('cloud://'.length).split('/').slice(1);
  return cloudPath.length === 3 && cloudPath[0] === 'avatars' && cloudPath[1] === userId;
}

function accountFileIds(user: UserDocument): readonly string[] {
  return [...new Set([user.avatarUrl, user.qrCodeFileId])].filter(
    (value): value is string => typeof value === 'string' && value.startsWith('cloud://'),
  );
}
