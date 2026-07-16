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
    expect(trip.projectionOutbox).toHaveLength(1);
  });
});
