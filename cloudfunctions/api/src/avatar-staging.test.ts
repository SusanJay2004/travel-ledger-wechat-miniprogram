import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import type { Clock, UserDocument } from './models';
import { MemoryRepository } from './repository';
import {
  downloadAvatarSource,
  isPublicAddress,
  stageAvatar,
  validateSourceUrl,
  type AvatarDownloadDependencies,
} from './avatar-staging';

describe('avatar staging source security', () => {
  it('accepts only standard credential-free HTTPS URLs', () => {
    expect(validateSourceUrl('https://cdn.example.com/avatar.jpg').hostname).toBe(
      'cdn.example.com',
    );
    for (const value of [
      'http://cdn.example.com/avatar.jpg',
      'https://user:password@cdn.example.com/avatar.jpg',
      'https://cdn.example.com:444/avatar.jpg',
      'not-a-url',
    ]) {
      expect(() => validateSourceUrl(value)).toThrow();
    }
  });

  it('rejects loopback, private, link-local, documentation, multicast, and mapped addresses', () => {
    for (const address of [
      '0.0.0.0',
      '10.0.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.1.1',
      '172.16.0.1',
      '192.0.0.1',
      '192.0.2.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '::1',
      'fc00::1',
      'fe80::1',
      'ff00::1',
      '2001:db8::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '64:ff9b::7f00:1',
      '64:ff9b:1::7f00:1',
      '2002:7f00:1::1',
      'fec0::1',
      '2001:2::1',
      '2001::1',
      '2001:10::1',
      '2001:20::1',
      '3fff::1',
      '4000::1',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('does not issue a request when DNS returns any non-public address', async () => {
    const request = vi.fn();
    const dependencies = {
      lookup: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      request,
    } as unknown as AvatarDownloadDependencies;

    await expect(
      downloadAvatarSource('https://cdn.example.com/avatar.jpg', dependencies),
    ).rejects.toMatchObject({ code: 'AVATAR_SOURCE_INVALID' });
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects both declared and streamed bodies above 1 MB', async () => {
    const declared = fakeDownloadDependencies({
      body: Buffer.from([0xff, 0xd8, 0xff]),
      headers: { 'content-length': String(1024 * 1024 + 1) },
    });
    await expect(
      downloadAvatarSource('https://cdn.example.com/avatar.jpg', declared),
    ).rejects.toMatchObject({ code: 'AVATAR_TOO_LARGE' });

    const streamed = fakeDownloadDependencies({ body: Buffer.alloc(1024 * 1024 + 1) });
    await expect(
      downloadAvatarSource('https://cdn.example.com/avatar.jpg', streamed),
    ).rejects.toMatchObject({ code: 'AVATAR_TOO_LARGE' });
  });

  it('revalidates redirects and blocks a redirect to a private host', async () => {
    const request = vi.fn((_options: object, callback: (response: FakeResponse) => void) => {
      queueMicrotask(() =>
        callback(new FakeResponse(302, Buffer.alloc(0), { location: 'https://private.test/a' })),
      );
      return new FakeRequest();
    });
    const dependencies = {
      lookup: async (hostname: string) => [
        { address: hostname === 'private.test' ? '127.0.0.1' : '8.8.8.8', family: 4 },
      ],
      request,
    } as unknown as AvatarDownloadDependencies;

    await expect(
      downloadAvatarSource('https://cdn.example.com/avatar.jpg', dependencies),
    ).rejects.toMatchObject({ code: 'AVATAR_SOURCE_INVALID' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('avatar staging state', () => {
  it('stores a deterministic account-owned candidate and reuses the same token', async () => {
    const repository = new MemoryRepository();
    const user = activeUser();
    await repository.createUser(user);
    const upload = vi.fn(async (path: string) => `cloud://env/${path}`);
    const storage = { delete: vi.fn(async () => undefined), upload };
    const download = vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0x00]));

    await expect(
      stageAvatar(
        repository,
        storage,
        clock,
        user,
        avatarInput('avatar-token-1', 'https://cdn.example.com/avatar.jpg'),
        download,
      ),
    ).resolves.toEqual({ avatarToken: 'avatar-token-1' });
    const staged = (await repository.getUser(user.id))!;
    expect(staged.stagedAvatarToken).toBe('avatar-token-1');
    expect(staged.stagedAvatarFileId).toContain(`cloud://env/avatars/${user.id}/staged-`);
    await expect(
      stageAvatar(
        repository,
        storage,
        clock,
        staged,
        avatarInput('avatar-token-1', 'https://cdn.example.com/different.jpg'),
        download,
      ),
    ).resolves.toEqual({ avatarToken: 'avatar-token-1' });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('deletes an uploaded candidate when the user version conflicts', async () => {
    const repository = new MemoryRepository();
    const user = activeUser();
    await repository.createUser(user);
    await repository.updateUser({ ...user, version: 2 }, user.version);
    const fileId = `cloud://env/avatars/${user.id}/staged.jpg`;
    const storage = {
      delete: vi.fn(async () => undefined),
      upload: vi.fn(async () => fileId),
    };

    await expect(
      stageAvatar(
        repository,
        storage,
        clock,
        user,
        avatarInput('avatar-token-2', 'https://cdn.example.com/avatar.jpg'),
        async () => Buffer.from([0xff, 0xd8, 0xff, 0x00]),
      ),
    ).rejects.toMatchObject({ code: 'PROFILE_VERSION_CONFLICT' });
    expect(storage.delete).toHaveBeenCalledWith(fileId);
  });

  it('queues a losing upload for durable cleanup when immediate deletion fails', async () => {
    const repository = new MemoryRepository();
    const user = activeUser();
    await repository.createUser(user);
    await repository.updateUser({ ...user, version: 2 }, user.version);
    const fileId = `cloud://env/avatars/${user.id}/losing.jpg`;
    const storage = {
      delete: vi.fn(async () => {
        throw new Error('storage unavailable');
      }),
      upload: vi.fn(async () => fileId),
    };

    await expect(
      stageAvatar(
        repository,
        storage,
        clock,
        user,
        avatarInput('avatar-token-3', 'https://cdn.example.com/avatar.jpg'),
        async () => jpeg,
      ),
    ).rejects.toMatchObject({ code: 'PROFILE_VERSION_CONFLICT' });
    expect((await repository.getUser(user.id))?.pendingFileDeletionIds).toEqual([fileId]);
  });

  it('removes the adopted candidate from a stale durable deletion queue', async () => {
    const repository = new MemoryRepository();
    const user = activeUser();
    const fileId = `cloud://env/avatars/${user.id}/restaged.jpg`;
    await repository.createUser({ ...user, pendingFileDeletionIds: [fileId] });
    const stored = (await repository.getUser(user.id))!;

    await stageAvatar(
      repository,
      { delete: vi.fn(async () => undefined), upload: vi.fn(async () => fileId) },
      clock,
      stored,
      avatarInput('avatar-token-restaged', 'https://cdn.example.com/avatar.jpg'),
      async () => jpeg,
    );

    expect(await repository.getUser(user.id)).toMatchObject({
      pendingFileDeletionIds: [],
      stagedAvatarFileId: fileId,
    });
  });

  it('uses distinct cloud paths when the same token is paired with different content', async () => {
    const firstRepository = new MemoryRepository();
    const secondRepository = new MemoryRepository();
    const firstUser = activeUser();
    const secondUser = activeUser();
    await firstRepository.createUser(firstUser);
    await secondRepository.createUser(secondUser);
    const paths: string[] = [];
    const storage = {
      delete: vi.fn(async () => undefined),
      upload: vi.fn(async (path: string) => {
        paths.push(path);
        return `cloud://env/${path}`;
      }),
    };
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    await stageAvatar(
      firstRepository,
      storage,
      clock,
      firstUser,
      avatarInput('shared-avatar-token', 'https://cdn.example.com/a.jpg'),
      async () => jpeg,
    );
    await stageAvatar(
      secondRepository,
      storage,
      clock,
      secondUser,
      {
        avatarToken: 'shared-avatar-token',
        sha256: createHash('sha256').update(png).digest('hex'),
        size: png.byteLength,
        sourceUrl: 'https://cdn.example.com/b.png',
      },
      async () => png,
    );

    expect(paths).toHaveLength(2);
    expect(paths[0]).not.toBe(paths[1]);
  });

  it('does not reuse a cloud path after the user version changes', async () => {
    const paths: string[] = [];
    const storage = {
      delete: vi.fn(async () => undefined),
      upload: vi.fn(async (path: string) => {
        paths.push(path);
        return `cloud://env/${path}`;
      }),
    };
    for (const version of [1, 2]) {
      const repository = new MemoryRepository();
      const user = { ...activeUser(), version };
      await repository.createUser(user);
      await stageAvatar(
        repository,
        storage,
        clock,
        user,
        avatarInput('version-bound-token', 'https://cdn.example.com/avatar.jpg'),
        async () => jpeg,
      );
    }

    expect(paths).toHaveLength(2);
    expect(paths[0]).not.toBe(paths[1]);
  });
});

const clock: Clock = { now: () => new Date('2026-07-17T08:00:00.000Z') };
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);

function avatarInput(avatarToken: string, sourceUrl: string) {
  return {
    avatarToken,
    sourceUrl,
    size: jpeg.byteLength,
    sha256: createHash('sha256').update(jpeg).digest('hex'),
  };
}

function activeUser(): UserDocument {
  return {
    id: 'usr_avatar',
    openId: 'openid-avatar',
    publicId: 'AVATAR2345',
    displayName: '头像用户',
    signature: '签名',
    avatarUrl: null,
    homeTripCount: 0,
    status: 'active',
    version: 1,
    createdAt: clock.now().toISOString(),
    updatedAt: clock.now().toISOString(),
  };
}

function fakeDownloadDependencies(options: {
  body: Buffer;
  headers?: Record<string, string>;
}): AvatarDownloadDependencies {
  return {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: (_requestOptions, callback) => {
      queueMicrotask(() =>
        callback(
          new FakeResponse(200, options.body, options.headers) as unknown as Parameters<
            typeof callback
          >[0],
        ),
      );
      return new FakeRequest();
    },
  };
}

class FakeRequest extends EventEmitter {
  destroy(error?: Error): void {
    if (error !== undefined) this.emit('error', error);
  }

  end(): void {}

  setTimeout(_timeout: number, _listener: () => void): this {
    return this;
  }
}

class FakeResponse extends EventEmitter {
  destroyed = false;

  constructor(
    readonly statusCode: number,
    private readonly body: Buffer,
    readonly headers: Record<string, string> = {},
  ) {
    super();
    queueMicrotask(() => {
      if (this.destroyed) return;
      this.emit('data', this.body);
      if (!this.destroyed) this.emit('end');
    });
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  resume(): this {
    return this;
  }
}
