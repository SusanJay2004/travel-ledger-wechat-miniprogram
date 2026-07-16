import { describe, expect, it, vi } from 'vitest';

import { inviteBatch } from './invite-batch';

describe('inviteBatch', () => {
  const candidates = [
    { userId: 'alice', displayName: '小艾' },
    { userId: 'bob', displayName: '小博' },
    { userId: 'carol', displayName: '小可' },
  ];

  it('reports every success when all invitations are accepted by the API', async () => {
    const invite = vi.fn(async () => undefined);

    const result = await inviteBatch(candidates, invite);

    expect(result.succeeded).toEqual(candidates);
    expect(result.failed).toEqual([]);
    expect(invite).toHaveBeenCalledTimes(3);
  });

  it('keeps trying and identifies partial failures without losing earlier successes', async () => {
    const invite = vi.fn(async (candidate: (typeof candidates)[number]) => {
      if (candidate.userId === 'bob') throw new Error('该好友已经在行程中。');
    });

    const result = await inviteBatch(candidates, invite);

    expect(result.succeeded.map((candidate) => candidate.userId)).toEqual(['alice', 'carol']);
    expect(result.failed).toEqual([{ candidate: candidates[1], message: '该好友已经在行程中。' }]);
    expect(invite).toHaveBeenCalledTimes(3);
  });
});
