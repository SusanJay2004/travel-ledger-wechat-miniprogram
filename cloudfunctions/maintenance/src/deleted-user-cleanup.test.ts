import { describe, expect, it, vi } from 'vitest';

import { cleanDeletedUserFiles } from './deleted-user-cleanup';

describe('cleanDeletedUserFiles', () => {
  const now = new Date('2026-08-20T00:00:00.000Z');

  it('deletes every marked file and clears the marker with its expected version', async () => {
    const deleteFiles = vi.fn(async () => undefined);
    const clearMarker = vi.fn(async () => true);
    const user = {
      id: 'user-1',
      pendingFileDeletionIds: ['cloud://env/avatar.png', 'cloud://env/code.png'],
      version: 3,
    };

    const summary = await cleanDeletedUserFiles([user], { clearMarker, deleteFiles }, now);

    expect(deleteFiles).toHaveBeenCalledWith(user.pendingFileDeletionIds);
    expect(clearMarker).toHaveBeenCalledWith(user, now.toISOString());
    expect(summary).toEqual({ failed: 0, removed: 2 });
  });

  it('retains the marker when cloud deletion fails so a later run can retry', async () => {
    const clearMarker = vi.fn(async () => true);
    const summary = await cleanDeletedUserFiles(
      [{ id: 'user-1', pendingFileDeletionIds: ['cloud://env/avatar.png'], version: 3 }],
      {
        clearMarker,
        deleteFiles: async () => {
          throw new Error('storage unavailable');
        },
      },
      now,
    );

    expect(clearMarker).not.toHaveBeenCalled();
    expect(summary).toEqual({ failed: 1, removed: 0 });
  });

  it('reports a version conflict instead of clearing a concurrently changed marker', async () => {
    const summary = await cleanDeletedUserFiles(
      [{ id: 'user-1', pendingFileDeletionIds: ['cloud://env/avatar.png'], version: 3 }],
      { clearMarker: async () => false, deleteFiles: async () => undefined },
      now,
    );

    expect(summary).toEqual({ failed: 1, removed: 0 });
  });

  it('never deletes a marked file that the current user document still references', async () => {
    const deleteFiles = vi.fn(async () => undefined);
    const clearMarker = vi.fn(async () => true);
    const activeAvatar = 'cloud://env/avatar-active.png';
    const obsoleteAvatar = 'cloud://env/avatar-old.png';

    const summary = await cleanDeletedUserFiles(
      [
        {
          avatarUrl: activeAvatar,
          id: 'user-1',
          pendingFileDeletionIds: [activeAvatar, obsoleteAvatar],
          version: 3,
        },
      ],
      { clearMarker, deleteFiles },
      now,
    );

    expect(deleteFiles).toHaveBeenCalledWith([obsoleteAvatar]);
    expect(clearMarker).toHaveBeenCalledOnce();
    expect(summary).toEqual({ failed: 0, removed: 1 });
  });
});
