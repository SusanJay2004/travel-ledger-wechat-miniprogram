import { describe, expect, it } from 'vitest';

import {
  BACKUP_COLLECTIONS,
  appendBackupProgress,
  backupDay,
  backupIdForDay,
  backupPrefix,
  expiresAt,
  pagePath,
} from './backup';

describe('backup helpers', () => {
  it('uses Beijing calendar days, deterministic ids, isolated attempts, and padded paths', () => {
    const now = new Date('2026-07-17T20:30:00.000Z');
    const day = backupDay(now);
    const backupId = backupIdForDay(day);
    const prefix = backupPrefix(day, backupId, 'attempt-1');
    expect(day).toBe('2026-07-18');
    expect(backupId).toBe('bak_20260718');
    expect(prefix).toBe('private-backups/2026-07-18/bak_20260718/attempt_attempt-1');
    expect(pagePath(prefix, 'trips', 12)).toBe(
      'private-backups/2026-07-18/bak_20260718/attempt_attempt-1/trips/00012.json.gz',
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

  it('retains every uploaded page in progress state for failed-backup cleanup', () => {
    const first = appendBackupProgress(
      { collections: {}, fileIds: [] },
      'users',
      ['cloud://backup/users/0', 'cloud://backup/users/1'],
      { documents: 101, pages: 2 },
    );
    const second = appendBackupProgress(first, 'trips', ['cloud://backup/trips/0'], {
      documents: 20,
      pages: 1,
    });

    expect(second).toEqual({
      collections: {
        users: { documents: 101, pages: 2 },
        trips: { documents: 20, pages: 1 },
      },
      fileIds: ['cloud://backup/users/0', 'cloud://backup/users/1', 'cloud://backup/trips/0'],
    });
  });
});
