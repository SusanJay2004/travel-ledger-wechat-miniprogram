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
      expect(stored['qrCodeFileId']).toBe(
        `cloud://memory/profile-codes/${String(stored['id'])}/${String(stored['qrSceneToken'])}.png`,
      );

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

  it('rejects oversized bill member arrays at the request boundary', async () => {
    const cloud = createMemoryCloudSdk('openid-alice');
    const bootstrap = await command(cloud.sdk, 'session.bootstrap', {}, 'member-cap-bootstrap');
    const profile = successData(bootstrap) as { userId: string };
    const created = await command(
      cloud.sdk,
      'trip.create',
      { name: '输入边界' },
      'member-cap-trip',
    );
    const trip = successData(created) as { tripId: string; trip: { version: number } };
    const dated = await command(
      cloud.sdk,
      'trip.addDate',
      { tripId: trip.tripId, date: '2026-07-10', expectedVersion: trip.trip.version },
      'member-cap-date',
    );
    const current = successData(dated) as { version: number };
    const participants = Array.from({ length: 21 }, () => ({
      memberId: profile.userId,
      displayName: '伪造名称',
      shares: 1,
    }));

    const response = await command(
      cloud.sdk,
      'trip.addBill',
      {
        tripId: trip.tripId,
        date: '2026-07-10',
        expectedVersion: current.version,
        bill: {
          title: '超大数组',
          amountCents: 100,
          participants,
          payers: [{ memberId: profile.userId, displayName: '伪造名称', paidCents: 100 }],
        },
      },
      'member-cap-bill',
    );

    expect(response).toMatchObject({ ok: false, error: { code: 'REQUEST_INVALID' } });
  });

  it('deletes account files and clears the durable cleanup marker', async () => {
    const previousMode = process.env['PRODUCT_MODE'];
    process.env['PRODUCT_MODE'] = 'collaboration';
    try {
      const cloud = createMemoryCloudSdk('openid-cleanup');
      await command(cloud.sdk, 'session.bootstrap', {}, 'cleanup-bootstrap');
      const generated = await command(cloud.sdk, 'session.qrCode', {}, 'cleanup-qr');
      const fileId = (successData(generated) as { fileId: string }).fileId;

      const deleted = await command(cloud.sdk, 'session.deleteAccount', {}, 'cleanup-delete');

      expect(deleted).toMatchObject({ ok: true });
      expect(cloud.deletedFileIds).toContain(fileId);
      expect(cloud.database.documents('users')[0]).toMatchObject({
        status: 'deleted',
        pendingFileDeletionIds: [],
      });
    } finally {
      if (previousMode === undefined) delete process.env['PRODUCT_MODE'];
      else process.env['PRODUCT_MODE'] = previousMode;
    }
  });

  it('atomically admits only one of two concurrent trips at the 100-trip boundary', async () => {
    const cloud = createMemoryCloudSdk('openid-capacity-race');
    const bootstrap = await command(cloud.sdk, 'session.bootstrap', {}, 'capacity-race-bootstrap');
    const profile = successData(bootstrap) as { userId: string };
    const users = cloud.database.collection<Record<string, unknown>>('users');
    const stored = cloud.database.documents('users')[0]!;
    await users.doc(profile.userId).set({
      data: { ...stored, homeTripCount: 99, version: Number(stored['version']) + 1 },
    });

    const results = await Promise.all([
      command(cloud.sdk, 'trip.create', { name: '并发甲' }, 'capacity-race-first'),
      command(cloud.sdk, 'trip.create', { name: '并发乙' }, 'capacity-race-second'),
    ]);

    expect(results.filter((result) => result['ok'] === true)).toHaveLength(1);
    const failure = results.find((result) => result['ok'] === false);
    expect((failure?.['error'] as { code?: string } | undefined)?.code).toBe('TRIP_LIMIT_REACHED');
    expect(cloud.database.documents('users')[0]).toMatchObject({ homeTripCount: 100 });
    expect(cloud.database.documents('trips')).toHaveLength(1);
  });

  it('rolls back trip membership and capacity when invitation status cannot commit', async () => {
    const previousMode = process.env['PRODUCT_MODE'];
    process.env['PRODUCT_MODE'] = 'collaboration';
    try {
      const cloud = createMemoryCloudSdk('openid-alice');
      const alice = successData(
        await command(cloud.sdk, 'session.bootstrap', {}, 'atomic-invite-alice'),
      ) as { userId: string; publicId: string };
      cloud.setOpenId('openid-bob');
      const bob = successData(
        await command(cloud.sdk, 'session.bootstrap', {}, 'atomic-invite-bob'),
      ) as { userId: string; publicId: string };

      cloud.setOpenId('openid-alice');
      await command(
        cloud.sdk,
        'social.sendFriendRequest',
        { publicId: bob.publicId },
        'atomic-friend-send',
      );
      const friendNotification = cloud.database
        .documents('notifications')
        .find((item) => item['type'] === 'friend_request')!;
      cloud.setOpenId('openid-bob');
      await command(
        cloud.sdk,
        'social.respondFriendRequest',
        { requestId: friendNotification['requestId'], accept: true },
        'atomic-friend-accept',
      );

      cloud.setOpenId('openid-alice');
      const created = successData(
        await command(cloud.sdk, 'trip.create', { name: '原子邀请' }, 'atomic-trip-create'),
      ) as { tripId: string };
      await command(
        cloud.sdk,
        'social.inviteToTrip',
        { tripId: created.tripId, inviteeUserId: bob.userId },
        'atomic-trip-invite',
      );
      const tripNotification = cloud.database
        .documents('notifications')
        .find((item) => item['type'] === 'trip_invitation')!;

      cloud.setOpenId('openid-bob');
      cloud.database.failNextSet('trip_invitations');
      const response = await command(
        cloud.sdk,
        'social.respondTripInvitation',
        { invitationId: tripNotification['invitationId'], accept: true },
        'atomic-trip-accept',
      );

      expect(response).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
      expect(cloud.database.documents('trips')[0]?.['memberIds']).toEqual([alice.userId]);
      expect(
        cloud.database.documents('users').find((item) => item['id'] === bob.userId),
      ).toMatchObject({ homeTripCount: 0 });
      expect(cloud.database.documents('trip_invitations')[0]).toMatchObject({ status: 'pending' });
    } finally {
      if (previousMode === undefined) delete process.env['PRODUCT_MODE'];
      else process.env['PRODUCT_MODE'] = previousMode;
    }
  });

  it('admits an invitee only once when the same invitation is accepted concurrently', async () => {
    const previousMode = process.env['PRODUCT_MODE'];
    process.env['PRODUCT_MODE'] = 'collaboration';
    try {
      const cloud = createMemoryCloudSdk('openid-concurrent-alice');
      const alice = successData(
        await command(cloud.sdk, 'session.bootstrap', {}, 'concurrent-invite-alice'),
      ) as { userId: string };
      cloud.setOpenId('openid-concurrent-bob');
      const bob = successData(
        await command(cloud.sdk, 'session.bootstrap', {}, 'concurrent-invite-bob'),
      ) as { userId: string; publicId: string };

      cloud.setOpenId('openid-concurrent-alice');
      await command(
        cloud.sdk,
        'social.sendFriendRequest',
        { publicId: bob.publicId },
        'concurrent-friend-send',
      );
      const requestId = cloud.database
        .documents('friend_requests')
        .find((item) => item['toUserId'] === bob.userId)?.['id'];
      cloud.setOpenId('openid-concurrent-bob');
      await command(
        cloud.sdk,
        'social.respondFriendRequest',
        { requestId, accept: true },
        'concurrent-friend-accept',
      );

      cloud.setOpenId('openid-concurrent-alice');
      const created = successData(
        await command(cloud.sdk, 'trip.create', { name: '并发接受邀请' }, 'concurrent-trip-create'),
      ) as { tripId: string };
      await command(
        cloud.sdk,
        'social.inviteToTrip',
        { tripId: created.tripId, inviteeUserId: bob.userId },
        'concurrent-trip-invite',
      );
      const invitationId = cloud.database.documents('trip_invitations')[0]?.['id'];

      cloud.setOpenId('openid-concurrent-bob');
      const responses = await Promise.all([
        command(
          cloud.sdk,
          'social.respondTripInvitation',
          { invitationId, accept: true },
          'concurrent-accept-first',
        ),
        command(
          cloud.sdk,
          'social.respondTripInvitation',
          { invitationId, accept: true },
          'concurrent-accept-second',
        ),
      ]);

      expect(responses.filter((response) => response['ok'] === true)).toHaveLength(1);
      expect(responses.find((response) => response['ok'] === false)).toMatchObject({
        error: { code: 'INVITATION_PROCESSED' },
      });
      expect(cloud.database.documents('trips')[0]?.['memberIds']).toEqual([
        alice.userId,
        bob.userId,
      ]);
      expect(
        cloud.database.documents('users').find((item) => item['id'] === bob.userId),
      ).toMatchObject({ homeTripCount: 1 });
      expect(cloud.database.documents('trip_invitations')[0]).toMatchObject({
        status: 'accepted',
      });
    } finally {
      if (previousMode === undefined) delete process.env['PRODUCT_MODE'];
      else process.env['PRODUCT_MODE'] = previousMode;
    }
  });

  it('rolls back friendship creation when friend request status cannot commit', async () => {
    const previousMode = process.env['PRODUCT_MODE'];
    process.env['PRODUCT_MODE'] = 'collaboration';
    try {
      const setup = await prepareFriendRequest('friend-rollback');
      setup.cloud.setOpenId(setup.bobOpenId);
      setup.cloud.database.failNextSet('friend_requests');

      const response = await command(
        setup.cloud.sdk,
        'social.respondFriendRequest',
        { requestId: setup.requestId, accept: true },
        'friend-rollback-accept',
      );

      expect(response).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
      expect(setup.cloud.database.documents('friendships')).toEqual([]);
      expect(setup.cloud.database.documents('friend_requests')[0]).toMatchObject({
        status: 'pending',
      });
    } finally {
      if (previousMode === undefined) delete process.env['PRODUCT_MODE'];
      else process.env['PRODUCT_MODE'] = previousMode;
    }
  });

  it('accepts the same friend request only once under concurrent taps', async () => {
    const previousMode = process.env['PRODUCT_MODE'];
    process.env['PRODUCT_MODE'] = 'collaboration';
    try {
      const setup = await prepareFriendRequest('friend-race');
      setup.cloud.setOpenId(setup.bobOpenId);

      const responses = await Promise.all([
        command(
          setup.cloud.sdk,
          'social.respondFriendRequest',
          { requestId: setup.requestId, accept: true },
          'friend-race-first',
        ),
        command(
          setup.cloud.sdk,
          'social.respondFriendRequest',
          { requestId: setup.requestId, accept: true },
          'friend-race-second',
        ),
      ]);

      expect(responses.filter((response) => response['ok'] === true)).toHaveLength(1);
      expect(responses.find((response) => response['ok'] === false)).toMatchObject({
        error: { code: 'FRIEND_REQUEST_PROCESSED' },
      });
      expect(setup.cloud.database.documents('friendships')).toHaveLength(1);
      expect(setup.cloud.database.documents('friend_requests')[0]).toMatchObject({
        status: 'accepted',
      });
    } finally {
      if (previousMode === undefined) delete process.env['PRODUCT_MODE'];
      else process.env['PRODUCT_MODE'] = previousMode;
    }
  });

  it('keeps invitation, membership and capacity consistent in an accept-reject race', async () => {
    const previousMode = process.env['PRODUCT_MODE'];
    process.env['PRODUCT_MODE'] = 'collaboration';
    try {
      const setup = await prepareTripInvitation('invitation-race');
      setup.cloud.setOpenId(setup.bobOpenId);

      const responses = await Promise.all([
        command(
          setup.cloud.sdk,
          'social.respondTripInvitation',
          { invitationId: setup.invitationId, accept: true },
          'invitation-race-accept',
        ),
        command(
          setup.cloud.sdk,
          'social.respondTripInvitation',
          { invitationId: setup.invitationId, accept: false },
          'invitation-race-reject',
        ),
      ]);

      expect(responses.filter((response) => response['ok'] === true)).toHaveLength(1);
      expect(responses.find((response) => response['ok'] === false)).toMatchObject({
        error: { code: 'INVITATION_PROCESSED' },
      });
      const invitation = setup.cloud.database.documents('trip_invitations')[0]!;
      const trip = setup.cloud.database.documents('trips')[0]!;
      const bob = setup.cloud.database
        .documents('users')
        .find((item) => item['id'] === setup.bobUserId)!;
      if (invitation['status'] === 'accepted') {
        expect(trip['memberIds']).toEqual([setup.aliceUserId, setup.bobUserId]);
        expect(bob).toMatchObject({ homeTripCount: 1 });
      } else {
        expect(invitation['status']).toBe('rejected');
        expect(trip['memberIds']).toEqual([setup.aliceUserId]);
        expect(bob).toMatchObject({ homeTripCount: 0 });
      }
    } finally {
      if (previousMode === undefined) delete process.env['PRODUCT_MODE'];
      else process.env['PRODUCT_MODE'] = previousMode;
    }
  });

  it('deduplicates concurrent friend requests even when devices use different request ids', async () => {
    const previousMode = process.env['PRODUCT_MODE'];
    process.env['PRODUCT_MODE'] = 'collaboration';
    try {
      const cloud = createMemoryCloudSdk('openid-request-dedupe-alice');
      await command(cloud.sdk, 'session.bootstrap', {}, 'request-dedupe-alice');
      cloud.setOpenId('openid-request-dedupe-bob');
      const bob = successData(
        await command(cloud.sdk, 'session.bootstrap', {}, 'request-dedupe-bob'),
      ) as { publicId: string };
      cloud.setOpenId('openid-request-dedupe-alice');

      const responses = await Promise.all([
        command(
          cloud.sdk,
          'social.sendFriendRequest',
          { publicId: bob.publicId },
          'request-dedupe-first',
        ),
        command(
          cloud.sdk,
          'social.sendFriendRequest',
          { publicId: bob.publicId },
          'request-dedupe-second',
        ),
      ]);

      expect(responses.every((response) => response['ok'] === true)).toBe(true);
      expect(successData(responses[0])).toEqual(successData(responses[1]));
      expect(cloud.database.documents('friend_requests')).toHaveLength(1);
      expect(
        cloud.database
          .documents('notifications')
          .filter((item) => item['type'] === 'friend_request'),
      ).toHaveLength(1);
    } finally {
      if (previousMode === undefined) delete process.env['PRODUCT_MODE'];
      else process.env['PRODUCT_MODE'] = previousMode;
    }
  });

  it('deduplicates concurrent invitations and permits a fresh one immediately after expiry', async () => {
    const previousMode = process.env['PRODUCT_MODE'];
    process.env['PRODUCT_MODE'] = 'collaboration';
    try {
      const setup = await prepareFriendRequest('invitation-dedupe');
      setup.cloud.setOpenId(setup.bobOpenId);
      await command(
        setup.cloud.sdk,
        'social.respondFriendRequest',
        { requestId: setup.requestId, accept: true },
        'invitation-dedupe-friend-accept',
      );
      setup.cloud.setOpenId(setup.aliceOpenId);
      const trip = successData(
        await command(
          setup.cloud.sdk,
          'trip.create',
          { name: '邀请去重' },
          'invitation-dedupe-trip',
        ),
      ) as { tripId: string };

      const responses = await Promise.all([
        command(
          setup.cloud.sdk,
          'social.inviteToTrip',
          { tripId: trip.tripId, inviteeUserId: setup.bobUserId },
          'invitation-dedupe-first',
        ),
        command(
          setup.cloud.sdk,
          'social.inviteToTrip',
          { tripId: trip.tripId, inviteeUserId: setup.bobUserId },
          'invitation-dedupe-second',
        ),
      ]);
      expect(successData(responses[0])).toEqual(successData(responses[1]));
      expect(setup.cloud.database.documents('trip_invitations')).toHaveLength(1);
      expect(
        setup.cloud.database
          .documents('notifications')
          .filter((item) => item['type'] === 'trip_invitation'),
      ).toHaveLength(1);

      const invitations =
        setup.cloud.database.collection<Record<string, unknown>>('trip_invitations');
      const expired = setup.cloud.database.documents('trip_invitations')[0]!;
      await invitations.doc(String(expired['id'])).set({
        data: { ...expired, expiresAt: '2000-01-01T00:00:00.000Z' },
      });
      const fresh = await command(
        setup.cloud.sdk,
        'social.inviteToTrip',
        { tripId: trip.tripId, inviteeUserId: setup.bobUserId },
        'invitation-dedupe-after-expiry',
      );

      expect(fresh).toMatchObject({ ok: true });
      expect(setup.cloud.database.documents('trip_invitations')).toHaveLength(2);
      const records = setup.cloud.database.documents('trip_invitations');
      expect(records.filter((item) => item['status'] === 'pending')).toHaveLength(1);
      expect(records.find((item) => item['status'] === 'expired')?.['pendingKey']).toMatch(
        /^resolved_/,
      );
    } finally {
      if (previousMode === undefined) delete process.env['PRODUCT_MODE'];
      else process.env['PRODUCT_MODE'] = previousMode;
    }
  });
});

async function prepareFriendRequest(prefix: string) {
  const aliceOpenId = `openid-${prefix}-alice`;
  const bobOpenId = `openid-${prefix}-bob`;
  const cloud = createMemoryCloudSdk(aliceOpenId);
  const alice = successData(
    await command(cloud.sdk, 'session.bootstrap', {}, `${prefix}-alice-bootstrap`),
  ) as { userId: string };
  cloud.setOpenId(bobOpenId);
  const bob = successData(
    await command(cloud.sdk, 'session.bootstrap', {}, `${prefix}-bob-bootstrap`),
  ) as { userId: string; publicId: string };
  cloud.setOpenId(aliceOpenId);
  await command(
    cloud.sdk,
    'social.sendFriendRequest',
    { publicId: bob.publicId },
    `${prefix}-send`,
  );
  const requestId = String(cloud.database.documents('friend_requests')[0]?.['id']);
  return {
    aliceOpenId,
    aliceUserId: alice.userId,
    bobOpenId,
    bobUserId: bob.userId,
    cloud,
    requestId,
  };
}

async function prepareTripInvitation(prefix: string) {
  const setup = await prepareFriendRequest(prefix);
  setup.cloud.setOpenId(setup.bobOpenId);
  await command(
    setup.cloud.sdk,
    'social.respondFriendRequest',
    { requestId: setup.requestId, accept: true },
    `${prefix}-friend-accept`,
  );
  setup.cloud.setOpenId(setup.aliceOpenId);
  const created = successData(
    await command(setup.cloud.sdk, 'trip.create', { name: '邀请竞态' }, `${prefix}-trip-create`),
  ) as { tripId: string };
  await command(
    setup.cloud.sdk,
    'social.inviteToTrip',
    { tripId: created.tripId, inviteeUserId: setup.bobUserId },
    `${prefix}-trip-invite`,
  );
  return {
    ...setup,
    invitationId: String(setup.cloud.database.documents('trip_invitations')[0]?.['id']),
  };
}

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
