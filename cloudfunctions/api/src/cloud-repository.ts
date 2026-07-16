import type { TripDocument, UserDocument } from './models';
import type { Repository } from './repository';

export interface QueryResult<T> {
  data: T[];
}

export interface UpdateResult {
  stats?: { updated?: number };
}

export interface CloudDocumentReference<T> {
  readonly collectionName?: string;
  readonly id?: string;
  get(): Promise<{ data: T }>;
  remove(): Promise<unknown>;
  set(options: { data: T }): Promise<unknown>;
}

export interface CloudCollection<T> {
  add(options: { data: T }): Promise<unknown>;
  doc(id: string): CloudDocumentReference<T>;
  get(): Promise<QueryResult<T>>;
  limit(value: number): CloudCollection<T>;
  skip(value: number): CloudCollection<T>;
  where(query: Record<string, unknown>): CloudCollection<T>;
  remove(): Promise<UpdateResult>;
  update(options: { data: Partial<T> }): Promise<UpdateResult>;
}

export interface CloudDatabase {
  collection<T>(name: string): CloudCollection<T>;
  runTransaction(
    callback: (transaction: CloudTransaction) => void | Promise<unknown>,
    retries?: number,
  ): Promise<unknown>;
}

export interface CloudTransaction {
  get<T>(document: CloudDocumentReference<T>): Promise<{ data(): T }>;
  set<T>(document: CloudDocumentReference<T>, data: T): Promise<unknown>;
}

export class CloudRepository implements Repository {
  constructor(private readonly db: CloudDatabase) {}

  async findUserByOpenId(openId: string): Promise<UserDocument | null> {
    const result = await this.users().where({ openId }).limit(1).get();
    return result.data[0] ?? null;
  }

  async findUserByPublicId(publicId: string): Promise<UserDocument | null> {
    const result = await this.users().where({ publicId }).limit(1).get();
    return result.data[0] ?? null;
  }

  async findUserByQrSceneToken(token: string): Promise<UserDocument | null> {
    const result = await this.users().where({ qrSceneToken: token }).limit(1).get();
    return result.data[0] ?? null;
  }

  async getUser(userId: string): Promise<UserDocument | null> {
    try {
      return (await this.users().doc(userId).get()).data;
    } catch (error: unknown) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  async createUser(user: UserDocument): Promise<void> {
    try {
      await this.users().add({ data: withDocumentId(user) });
    } catch (error: unknown) {
      if (isDuplicateError(error)) throw new Error('DUPLICATE_USER');
      throw error;
    }
  }

  async updateUser(user: UserDocument, expectedVersion: number): Promise<boolean> {
    const result = await this.users()
      .where({ _id: user.id, version: expectedVersion })
      .update({ data: withoutDocumentId(user) });
    return result.stats?.updated === 1;
  }

  async countHomeTrips(userId: string): Promise<number> {
    return (await this.listTripsForUser(userId)).filter(
      (trip) => trip.members.find((member) => member.userId === userId)?.viewState === 'home',
    ).length;
  }

  async listTripsForUser(userId: string): Promise<readonly TripDocument[]> {
    const trips: TripDocument[] = [];
    let offset = 0;
    while (true) {
      const result = await this.trips().where({ memberIds: userId }).skip(offset).limit(100).get();
      trips.push(...result.data);
      if (result.data.length < 100) break;
      offset += result.data.length;
    }
    return trips;
  }

  async getTrip(tripId: string): Promise<TripDocument | null> {
    try {
      return (await this.trips().doc(tripId).get()).data;
    } catch (error: unknown) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  async createTrip(trip: TripDocument): Promise<void> {
    await this.trips().add({ data: withDocumentId(trip) });
  }

  async createTripWithHomeCapacity(
    trip: TripDocument,
    userId: string,
    limit: number,
  ): Promise<'saved' | 'capacity_exceeded'> {
    let outcome: 'saved' | 'capacity_exceeded' = 'capacity_exceeded';
    await this.db.runTransaction(async (transaction) => {
      const userReference = this.users().doc(userId);
      const user = (await transaction.get(userReference)).data();
      if (user.homeTripCount >= limit) {
        outcome = 'capacity_exceeded';
        return;
      }
      outcome = 'saved';
      await transaction.set(
        userReference,
        withoutDocumentId({
          ...user,
          homeTripCount: user.homeTripCount + 1,
          version: user.version + 1,
        }),
      );
      await transaction.set(this.trips().doc(trip.id), withoutDocumentId(trip));
    });
    return outcome;
  }

  async replaceTrip(trip: TripDocument, expectedVersion: number): Promise<boolean> {
    const result = await this.trips()
      .where({ _id: trip.id, version: expectedVersion })
      .update({ data: withoutDocumentId(trip) });
    return result.stats?.updated === 1;
  }

  async replaceTripWithHomeCapacity(
    trip: TripDocument,
    expectedVersion: number,
    homeCountDeltas: Readonly<Record<string, number>>,
    limit: number,
  ): Promise<'saved' | 'version_conflict' | 'capacity_exceeded'> {
    let outcome: 'saved' | 'version_conflict' | 'capacity_exceeded' = 'version_conflict';
    await this.db.runTransaction(async (transaction) => {
      const tripReference = this.trips().doc(trip.id);
      const current = (await transaction.get(tripReference)).data();
      if (current.version !== expectedVersion) {
        outcome = 'version_conflict';
        return;
      }
      const userUpdates: Array<{
        reference: CloudDocumentReference<UserDocument>;
        user: UserDocument;
      }> = [];
      for (const [userId, delta] of Object.entries(homeCountDeltas)) {
        if (delta === 0) continue;
        const reference = this.users().doc(userId);
        const user = (await transaction.get(reference)).data();
        const homeTripCount = user.homeTripCount + delta;
        if (homeTripCount < 0) throw new Error('HOME_TRIP_COUNT_UNDERFLOW');
        if (homeTripCount > limit) {
          outcome = 'capacity_exceeded';
          return;
        }
        userUpdates.push({
          reference,
          user: { ...user, homeTripCount, version: user.version + 1 },
        });
      }
      outcome = 'saved';
      for (const update of userUpdates) {
        await transaction.set(update.reference, withoutDocumentId(update.user));
      }
      await transaction.set(tripReference, withoutDocumentId(trip));
    });
    return outcome;
  }

  private users() {
    return this.db.collection<UserDocument>('users');
  }

  private trips() {
    return this.db.collection<TripDocument>('trips');
  }
}

function withDocumentId<T extends { id: string }>(value: T): T & { _id: string } {
  return { ...value, _id: value.id };
}

function withoutDocumentId<T extends { id: string }>(value: T): T {
  const copy = { ...value } as T & { _id?: string };
  delete copy._id;
  return copy;
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const message = 'message' in error ? String(error.message) : '';
  const code = 'errCode' in error ? String(error.errCode) : '';
  return code.includes('DOCUMENT_NOT_FOUND') || message.toLowerCase().includes('not found');
}

function isDuplicateError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const message = 'message' in error ? String(error.message).toLowerCase() : '';
  const code = 'errCode' in error ? String(error.errCode).toLowerCase() : '';
  return (
    `${code} ${message}`.includes('duplicate') || `${code} ${message}`.includes('already exists')
  );
}
