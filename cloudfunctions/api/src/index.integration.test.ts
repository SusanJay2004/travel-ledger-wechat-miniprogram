import { describe, expect, it } from 'vitest';

import { handleApiEvent } from './index';
import { createMemoryCloudSdk } from './testing/memory-cloud';

describe('cloud API command integration', () => {
  it('rejects unauthenticated calls and invalid request ids before creating data', async () => {
    const cloud = createMemoryCloudSdk();
    cloud.setOpenId(undefined);
    expect(
      await handleApiEvent(
        { action: 'session.bootstrap', requestId: 'request-1', payload: {} },
        cloud.sdk,
      ),
    ).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    cloud.setOpenId('openid-alice');
    expect(
      await handleApiEvent(
        { action: 'session.bootstrap', requestId: 'bad', payload: {} },
        cloud.sdk,
      ),
    ).toMatchObject({ ok: false, error: { code: 'REQUEST_ID_INVALID' } });
    expect(cloud.database.documents('users')).toEqual([]);
  });

  it('runs an idempotent create/date/delete command chain and hides internal projections', async () => {
    const cloud = createMemoryCloudSdk('openid-alice');
    const bootstrap = await command(cloud.sdk, 'session.bootstrap', {}, 'request-boot');
    expect(bootstrap.ok).toBe(true);
    const created = await command(cloud.sdk, 'trip.create', { name: '青岛之旅' }, 'request-create');
    const replay = await command(cloud.sdk, 'trip.create', { name: '其他名字' }, 'request-create');
    expect(replay).toEqual(created);
    expect(cloud.database.documents('trips')).toHaveLength(1);
    const createdData = successData(created) as {
      tripId: string;
      trip: { version: number; projectionOutbox?: unknown };
    };
    expect(createdData.trip).not.toHaveProperty('projectionOutbox');
    const dated = await command(
      cloud.sdk,
      'trip.addDate',
      { tripId: createdData.tripId, date: '2026-07-10', expectedVersion: createdData.trip.version },
      'request-date-add',
    );
    const datedData = successData(dated) as { version: number };
    const deleted = await command(
      cloud.sdk,
      'trip.deleteDate',
      { tripId: createdData.tripId, date: '2026-07-10', expectedVersion: datedData.version },
      'request-date-delete',
    );
    expect(successData(deleted)).toMatchObject({ dates: [] });
  });

  it('uses trusted WeChat context instead of a forged payload user id', async () => {
    const cloud = createMemoryCloudSdk('openid-alice');
    await command(cloud.sdk, 'session.bootstrap', {}, 'request-alice');
    const created = await command(cloud.sdk, 'trip.create', { name: '私密行程' }, 'request-trip');
    const tripId = (successData(created) as { tripId: string }).tripId;

    cloud.setOpenId('openid-bob');
    await command(cloud.sdk, 'session.bootstrap', {}, 'request-bob');
    const forbidden = await command(
      cloud.sdk,
      'trip.get',
      { tripId, userId: 'usr_forged_alice' },
      'request-forbidden',
    );
    expect(forbidden).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('generates and resolves an opaque QR scene without embedding a public id', async () => {
    const previousMode = process.env['PRODUCT_MODE'];
    process.env['PRODUCT_MODE'] = 'collaboration';
    try {
      const cloud = createMemoryCloudSdk('openid-alice');
      const bootstrap = await command(cloud.sdk, 'session.bootstrap', {}, 'qr-bootstrap-alice');
      const alice = successData(bootstrap) as { publicId: string };
      await command(cloud.sdk, 'session.qrCode', {}, 'qr-generate-alice');
      const stored = cloud.database.documents('users')[0]!;
      expect(stored['qrSceneToken']).toMatch(/^[A-Za-z0-9_-]{20}$/);
      expect(String(stored['qrSceneToken'])).not.toContain(alice.publicId);

      cloud.setOpenId('openid-bob');
      await command(cloud.sdk, 'session.bootstrap', {}, 'qr-bootstrap-bob');
      const resolved = await command(
        cloud.sdk,
        'social.resolveQrScene',
        { token: stored['qrSceneToken'] },
        'qr-resolve-bob',
      );
      expect(successData(resolved)).toMatchObject({ publicId: alice.publicId });
      const malformed = await command(
        cloud.sdk,
        'social.resolveQrScene',
        { token: alice.publicId },
        'qr-resolve-malformed',
      );
      expect(malformed).toMatchObject({ ok: false, error: { code: 'QR_SCENE_INVALID' } });
    } finally {
      if (previousMode === undefined) delete process.env['PRODUCT_MODE'];
      else process.env['PRODUCT_MODE'] = previousMode;
    }
  });
});

async function command(
  sdk: Parameters<typeof handleApiEvent>[1],
  action: string,
  payload: Record<string, unknown>,
  requestId: string,
) {
  return handleApiEvent({ action, payload, requestId }, sdk) as Promise<Record<string, unknown>>;
}

function successData(response: Record<string, unknown>): unknown {
  expect(response['ok']).toBe(true);
  return response['data'];
}
