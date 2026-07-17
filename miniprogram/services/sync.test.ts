import { afterEach, describe, expect, it, vi } from 'vitest';

import { configureRuntimeMode } from '../config/runtime';
import { watchTripSync } from './sync';

describe('trip sync listener', () => {
  afterEach(() => {
    configureRuntimeMode('solo');
    vi.unstubAllGlobals();
  });

  it('includes the user and trip fields required by the database security rule', async () => {
    const close = vi.fn(async () => undefined);
    const watch = vi.fn(() => ({ close }));
    const where = vi.fn(() => ({ watch }));
    const collection = vi.fn(() => ({ where }));
    vi.stubGlobal('wx', { cloud: { database: () => ({ collection }) } });
    configureRuntimeMode('collaboration');

    const subscription = watchTripSync({
      userId: 'user-1',
      tripId: 'trip-1',
      onSync: vi.fn(),
      onError: vi.fn(),
    });

    expect(collection).toHaveBeenCalledWith('sync_events');
    expect(where).toHaveBeenCalledWith({
      userId: 'user-1',
      tripId: 'trip-1',
    });
    await subscription?.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
