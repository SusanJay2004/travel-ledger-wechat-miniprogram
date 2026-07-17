import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

interface Rule {
  read: boolean | string;
  write: boolean | string;
}

describe('cloud client security rules', () => {
  const databaseRules = JSON.parse(
    readFileSync(resolve('config/cloud-database-rules.json'), 'utf8'),
  ) as Record<string, Rule>;
  const storageRules = JSON.parse(
    readFileSync(resolve('config/cloud-storage-rules.json'), 'utf8'),
  ) as Rule;

  it('keeps every authoritative collection private except owner-checked sync signals', () => {
    expect(Object.keys(databaseRules).sort()).toEqual(
      [
        'audit_logs',
        'backup_manifests',
        'blocks',
        'friend_requests',
        'friendships',
        'idempotency_records',
        'notifications',
        'rate_limit_records',
        'sync_events',
        'trip_invitations',
        'trips',
        'users',
      ].sort(),
    );
    for (const [collection, rule] of Object.entries(databaseRules)) {
      expect(rule.write, collection).toBe(false);
      if (collection !== 'sync_events') expect(rule.read, collection).toBe(false);
    }
    expect(databaseRules['sync_events']?.read).toBe(
      'auth.openid == get(`database.users.${doc.userId}`).openId',
    );
  });

  it('allows client writes only for creator-owned avatar files', () => {
    expect(storageRules).toEqual({
      read: 'auth != null && (/^avatars\\//.test(resource.path) || /^profile-codes\\//.test(resource.path))',
      write: '/^avatars\\//.test(resource.path) && resource.openid == auth.openid',
    });
  });
});
