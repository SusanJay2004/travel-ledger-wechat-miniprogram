import type { TripDocument, UserDocument } from './models';

export interface Repository {
  findUserByOpenId(openId: string): Promise<UserDocument | null>;
  findUserByPublicId(publicId: string): Promise<UserDocument | null>;
  getUser(userId: string): Promise<UserDocument | null>;
  createUser(user: UserDocument): Promise<void>;
  updateUser(user: UserDocument): Promise<void>;

  countHomeTrips(userId: string): Promise<number>;
  listTripsForUser(userId: string): Promise<readonly TripDocument[]>;
  getTrip(tripId: string): Promise<TripDocument | null>;
  createTrip(trip: TripDocument): Promise<void>;
  replaceTrip(trip: TripDocument, expectedVersion: number): Promise<boolean>;
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

  async updateUser(user: UserDocument): Promise<void> {
    if (!this.users.has(user.id)) throw new Error('USER_NOT_FOUND');
    this.users.set(user.id, structuredClone(user));
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

  async replaceTrip(trip: TripDocument, expectedVersion: number): Promise<boolean> {
    const current = this.trips.get(trip.id);
    if (current === undefined || current.version !== expectedVersion) return false;
    this.trips.set(trip.id, structuredClone(trip));
    return true;
  }
}

function memberViewState(trip: TripDocument, userId: string) {
  return trip.members.find((member) => member.userId === userId)?.viewState;
}
