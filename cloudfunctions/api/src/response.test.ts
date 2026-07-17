import { describe, expect, it } from 'vitest';

import { sanitizeClientData } from './response';

describe('sanitizeClientData', () => {
  it('removes internal trip projections from individual and list responses', () => {
    const trip = {
      id: 'trip-1',
      members: [],
      bills: [],
      dates: [],
      ledgerRevision: 1,
      projectionOutbox: [{ id: 'out-1' }],
      settlementCache: { ledgerRevision: 1 },
    };
    expect(sanitizeClientData(trip)).not.toHaveProperty('projectionOutbox');
    expect(sanitizeClientData([trip])[0]).not.toHaveProperty('settlementCache');
    expect(sanitizeClientData({ tripId: trip.id, trip }).trip).not.toHaveProperty(
      'projectionOutbox',
    );
    expect(trip.projectionOutbox).toHaveLength(1);
  });

  it('removes private WeChat identity and QR resolution fields recursively', () => {
    const value = {
      _id: 'internal-document-key',
      openId: 'openid-secret',
      profile: {
        displayName: '旅人',
        ownerOpenId: 'openid-owner',
        qrSceneToken: 'opaque-but-private',
      },
    };

    expect(sanitizeClientData(value)).toEqual({ profile: { displayName: '旅人' } });
  });

  it('fails closed when an endpoint accidentally returns a raw cloud file id', () => {
    expect(
      sanitizeClientData({
        avatarUrl: 'cloud://env/avatars/user/avatar.jpg',
        eventTitle: 'cloud://x',
        fileId: 'cloud://env/private.png',
        safe: 'https://ok',
      }),
    ).toEqual({ avatarUrl: null, eventTitle: 'cloud://x', fileId: null, safe: 'https://ok' });
  });
});
