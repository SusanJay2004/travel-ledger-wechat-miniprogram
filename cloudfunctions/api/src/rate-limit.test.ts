import { describe, expect, it } from 'vitest';

import type { CloudCollection, CloudDatabase, QueryResult, UpdateResult } from './cloud-repository';
import type { Clock } from './models';
import { RateLimiter } from './rate-limit';

class TestClock implements Clock {
  constructor(private current = new Date('2026-07-17T08:00:00.000Z')) {}

  now() {
    return new Date(this.current);
  }

  advance(minutes: number) {
    this.current = new Date(this.current.getTime() + minutes * 60 * 1000);
  }
}

class MemoryDb implements CloudDatabase {
  readonly documents = new Map<string, Record<string, unknown>>();

  collection<T>(_name: string): CloudCollection<T> {
    return new MemoryCollection<T>(this);
  }

  async runTransaction(): Promise<never> {
    throw new Error('not used by rate-limit tests');
  }
}

class MemoryCollection<T> implements CloudCollection<T> {
  private query: Record<string, unknown> = {};
  private take = Infinity;

  constructor(private readonly database: MemoryDb) {}

  async add(options: { data: T }) {
    const item = options.data as Record<string, unknown>;
    const id = String(item['_id']);
    if (this.database.documents.has(id)) throw new Error('duplicate');
    this.database.documents.set(id, structuredClone(item));
  }

  doc(id: string) {
    return {
      get: async () => {
        const item = this.database.documents.get(id);
        if (item === undefined) throw new Error('not found');
        return { data: structuredClone(item) as T };
      },
      remove: async () => {
        this.database.documents.delete(id);
      },
      set: async (options: { data: T }) => {
        this.database.documents.set(id, structuredClone(options.data) as Record<string, unknown>);
      },
    };
  }

  async get(): Promise<QueryResult<T>> {
    return {
      data: [...this.database.documents.values()]
        .filter((item) => Object.entries(this.query).every(([key, value]) => item[key] === value))
        .slice(0, this.take) as T[],
    };
  }

  limit(value: number): CloudCollection<T> {
    this.take = value;
    return this;
  }

  skip(_value: number): CloudCollection<T> {
    return this;
  }

  where(query: Record<string, unknown>): CloudCollection<T> {
    this.query = query;
    return this;
  }

  async update(_options: { data: Partial<T> }): Promise<UpdateResult> {
    return { stats: { updated: 0 } };
  }

  async remove(): Promise<UpdateResult> {
    return { stats: { updated: 0 } };
  }
}

describe('RateLimiter', () => {
  it('counts a retried request only once', async () => {
    const limiter = new RateLimiter(new MemoryDb(), new TestClock());
    await limiter.consume('openid', 'request-1', 'social.search');
    await limiter.consume('openid', 'request-1', 'social.search');
  });

  it('rejects the next request at the policy limit and resets next window', async () => {
    const database = new MemoryDb();
    const clock = new TestClock();
    const limiter = new RateLimiter(database, clock);
    for (let index = 0; index < 30; index += 1) {
      await limiter.consume('openid', `request-${index}`, 'social.search');
    }
    await expect(limiter.consume('openid', 'request-over', 'social.search')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
    });
    clock.advance(1);
    await expect(
      limiter.consume('openid', 'request-new-window', 'social.search'),
    ).resolves.toBeUndefined();
  });

  it('uses separate counters per account', async () => {
    const limiter = new RateLimiter(new MemoryDb(), new TestClock());
    for (let index = 0; index < 30; index += 1) {
      await limiter.consume('alice', `request-${index}`, 'social.search');
    }
    await expect(limiter.consume('bob', 'request-1', 'social.search')).resolves.toBeUndefined();
  });
});
