import { describe, expect, it } from 'vitest';

import { BACKUP_COLLECTIONS, backupPrefix, expiresAt, pagePath } from './backup';

describe('backup helpers', () => {
  it('uses UTC day partitions and stable padded page paths', () => {
    const now = new Date('2026-07-17T20:30:00.000Z');
    const prefix = backupPrefix(now, 'bak_123');
    expect(prefix).toBe('private-backups/2026-07-17/bak_123');
    expect(pagePath(prefix, 'trips', 12)).toBe(
      'private-backups/2026-07-17/bak_123/trips/00012.json.gz',
    );
  });

  it('backs up authoritative records but excludes ephemeral request projections', () => {
    expect(BACKUP_COLLECTIONS).toContain('users');
    expect(BACKUP_COLLECTIONS).toContain('trips');
    expect(BACKUP_COLLECTIONS).not.toContain('sync_events');
    expect(BACKUP_COLLECTIONS).not.toContain('idempotency_records');
  });

  it('uses a 30-day backup retention by default', () => {
    expect(expiresAt(new Date('2026-07-17T00:00:00.000Z'))).toBe('2026-08-16T00:00:00.000Z');
  });
});
