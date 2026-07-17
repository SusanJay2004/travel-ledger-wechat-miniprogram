import type { TripDocument, UserDocument } from './models';

export interface Repository {
  findUserByOpenId(openId: string): Promise<UserDocument | null>;
  findUserByPublicId(publicId: string): Promise<UserDocument | null>;
  findUserByQrSceneToken(token: string): Promise<UserDocument | null>;
  getUser(userId: string): Promise<UserDocument | null>;
  createUser(user: UserDocument): Promise<void>;
  updateUser(user: UserDocument, expectedVersion: number): Promise<boolean>;

  countHomeTrips(userId: string): Promise<number>;
  listTripsForUser(userId: string): Promise<readonly TripDocument[]>;
  getTrip(tripId: string): Promise<TripDocument | null>;
  createTrip(trip: TripDocument): Promise<void>;
  createTripWithHomeCapacity(
    trip: TripDocument,
    userId: string,
    limit: number,
  ): Promise<'saved' | 'capacity_exceeded' | 'user_inactive'>;
  replaceTrip(trip: TripDocument, expectedVersion: number): Promise<boolean>;
  replaceTripWithHomeCapacity(
    trip: TripDocument,
    expectedVersion: number,
    homeCountDeltas: Readonly<Record<string, number>>,
    limit: number,
  ): Promise<'saved' | 'version_conflict' | 'capacity_exceeded' | 'user_inactive'>;
}

export class MemoryRepository implements Repository {
  private readonly users = new Map<string, UserDocument>();
  private readonly trips = new Map<string, TripDocument>();

  async findUserByOpenId(openId: string): Promise<UserDocument | null> {
    return [...this.users.values()].find((user) => user.openId === openId) ?? null;
  }

  async findUserByPublicId(publicId: string): Promise<UserDocument | null> {
    return [...this.users.values()].find((user) => user.publicId === publicId) ?? null;
  }

  async findUserByQrSceneToken(token: string): Promise<UserDocument | null> {
    const matches = [...this.users.values()].filter((user) => user.qrSceneToken === token);
    return matches.length === 1 ? structuredClone(matches[0]!) : null;
  }

  async getUser(userId: string): Promise<UserDocument | null> {
    const user = this.users.get(userId);
    return user === undefined ? null : structuredClone(user);
  }

  async createUser(user: UserDocument): Promise<void> {
    if (
      this.users.has(user.id) ||
      [...this.users.values()].some(
        (existing) => existing.openId === user.openId || existing.publicId === user.publicId,
      )
    ) {
      throw new Error('DUPLICATE_USER');
    }
    this.users.set(user.id, structuredClone(user));
  }

  async updateUser(user: UserDocument, expectedVersion: number): Promise<boolean> {
    const current = this.users.get(user.id);
    if (current === undefined || current.version !== expectedVersion) return false;
    this.users.set(user.id, structuredClone(user));
    return true;
  }

  async countHomeTrips(userId: string): Promise<number> {
    const trips = await this.listTripsForUser(userId);
    return trips.filter((trip) => memberViewState(trip, userId) === 'home').length;
  }

  async listTripsForUser(userId: string): Promise<readonly TripDocument[]> {
    return [...this.trips.values()]
      .filter((trip) => trip.memberIds.includes(userId))
      .map((trip) => structuredClone(trip));
  }

  async getTrip(tripId: string): Promise<TripDocument | null> {
    const trip = this.trips.get(tripId);
    return trip === undefined ? null : structuredClone(trip);
  }

  async createTrip(trip: TripDocument): Promise<void> {
    if (this.trips.has(trip.id)) throw new Error('DUPLICATE_TRIP');
    this.trips.set(trip.id, structuredClone(trip));
  }

  async createTripWithHomeCapacity(
    trip: TripDocument,
    userId: string,
    limit: number,
  ): Promise<'saved' | 'capacity_exceeded' | 'user_inactive'> {
    const user = this.users.get(userId);
    if (user === undefined) throw new Error('USER_NOT_FOUND');
    if (user.status !== 'active') return 'user_inactive';
    if (user.homeTripCount >= limit) return 'capacity_exceeded';
    if (this.trips.has(trip.id)) throw new Error('DUPLICATE_TRIP');
    this.users.set(userId, {
      ...user,
      homeTripCount: user.homeTripCount + 1,
      version: user.version + 1,
    });
    this.trips.set(trip.id, structuredClone(trip));
    return 'saved';
  }

  async replaceTrip(trip: TripDocument, expectedVersion: number): Promise<boolean> {
    const current = this.trips.get(trip.id);
    if (current === undefined || current.version !== expectedVersion) return false;
    this.trips.set(trip.id, structuredClone(trip));
    return true;
  }

  async replaceTripWithHomeCapacity(
    trip: TripDocument,
    expectedVersion: number,
    homeCountDeltas: Readonly<Record<string, number>>,
    limit: number,
  ): Promise<'saved' | 'version_conflict' | 'capacity_exceeded' | 'user_inactive'> {
    const current = this.trips.get(trip.id);
    if (current === undefined || current.version !== expectedVersion) return 'version_conflict';
    const updates = new Map<string, UserDocument>();
    for (const [userId, delta] of Object.entries(homeCountDeltas)) {
      if (delta === 0) continue;
      const user = this.users.get(userId);
      if (user === undefined) throw new Error('USER_NOT_FOUND');
      if (user.status !== 'active') return 'user_inactive';
      const homeTripCount = user.homeTripCount + delta;
      if (homeTripCount < 0) throw new Error('HOME_TRIP_COUNT_UNDERFLOW');
      if (homeTripCount > limit) return 'capacity_exceeded';
      updates.set(userId, { ...user, homeTripCount, version: user.version + 1 });
    }
    for (const [userId, user] of updates) this.users.set(userId, structuredClone(user));
    this.trips.set(trip.id, structuredClone(trip));
    return 'saved';
  }
}

function memberViewState(trip: TripDocument, userId: string) {
  return trip.members.find((member) => member.userId === userId)?.viewState;
}
