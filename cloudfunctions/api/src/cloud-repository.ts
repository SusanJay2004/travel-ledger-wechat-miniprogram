import type { TripDocument, UserDocument } from './models';
import type { Repository } from './repository';

interface QueryResult<T> {
  data: T[];
}

interface UpdateResult {
  stats?: { updated?: number };
}

interface Collection<T> {
  add(options: { data: T }): Promise<unknown>;
  doc(id: string): {
    get(): Promise<{ data: T }>;
    set(options: { data: T }): Promise<unknown>;
  };
  get(): Promise<QueryResult<T>>;
  limit(value: number): Collection<T>;
  skip(value: number): Collection<T>;
  where(query: Record<string, unknown>): Collection<T>;
  update(options: { data: Partial<T> }): Promise<UpdateResult>;
}

export interface CloudDatabase {
  collection<T>(name: string): Collection<T>;
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

  async createUser(user: UserDocument): Promise<void> {
    await this.users().add({ data: withDocumentId(user) });
  }

  async updateUser(user: UserDocument): Promise<void> {
    await this.users()
      .doc(user.id)
      .set({ data: withDocumentId(user) });
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

  async replaceTrip(trip: TripDocument, expectedVersion: number): Promise<boolean> {
    const result = await this.trips()
      .where({ _id: trip.id, version: expectedVersion })
      .update({ data: withoutDocumentId(trip) });
    return result.stats?.updated === 1;
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
