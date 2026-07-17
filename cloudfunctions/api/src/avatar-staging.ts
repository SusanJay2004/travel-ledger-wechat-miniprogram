import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

import { BusinessError } from './errors';
import { detectSupportedImageType } from './content-security';
import type { Clock, UserDocument } from './models';
import type { Repository } from './repository';

const MAX_AVATAR_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 2;
const REQUEST_TIMEOUT_MS = 5000;
const DNS_TIMEOUT_MS = 2000;
const STAGING_TTL_MS = 35 * 60 * 1000;

interface DownloadRequest {
  destroy(error?: Error): void;
  end(): void;
  on(event: 'error', listener: (error: Error) => void): void;
  setTimeout(timeout: number, listener: () => void): void;
}

export interface AvatarDownloadDependencies {
  lookup(hostname: string): Promise<readonly { address: string; family: number }[]>;
  request(options: RequestOptions, response: (message: IncomingMessage) => void): DownloadRequest;
}

export interface AvatarStagingStorage {
  delete(fileId: string): Promise<void>;
  upload(cloudPath: string, fileContent: Buffer): Promise<string>;
}

export async function stageAvatar(
  repository: Repository,
  storage: AvatarStagingStorage,
  clock: Clock,
  user: UserDocument,
  input: { avatarToken: string; sourceUrl: string; size: number; sha256: string },
  download: (url: string) => Promise<Buffer> = downloadAvatarSource,
): Promise<{ avatarToken: string }> {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(input.avatarToken)) {
    throw new BusinessError('AVATAR_TOKEN_INVALID', '头像暂存标识无效。');
  }
  assertAvatarMetadata(input.size, input.sha256);
  const now = clock.now();
  if (
    user.stagedAvatarToken === input.avatarToken &&
    user.stagedAvatarFileId?.startsWith('cloud://') === true &&
    validFutureTime(user.stagedAvatarExpiresAt, now)
  ) {
    if (user.stagedAvatarSize !== input.size || user.stagedAvatarSha256 !== input.sha256) {
      throw new BusinessError('AVATAR_TOKEN_REUSED', '同一头像暂存标识不能用于不同图片。');
    }
    return { avatarToken: input.avatarToken };
  }

  const fileContent = await download(input.sourceUrl);
  assertAvatarContent(fileContent, input.size, input.sha256);
  const mediaType = detectSupportedImageType(fileContent);
  const extension = mediaType === 'image/png' ? 'png' : 'jpg';
  const digest = createHash('sha256')
    .update(`${user.version}:${input.avatarToken}:${input.sha256}`)
    .digest('hex')
    .slice(0, 24);
  const fileId = await storage.upload(
    `avatars/${user.id}/staged-${digest}.${extension}`,
    fileContent,
  );
  if (!avatarBelongsToUser(fileId, user.id)) {
    await discardStagedFile(repository, storage, clock, user.id, fileId);
    throw new BusinessError('AVATAR_UPLOAD_FAILED', '头像暂存失败，请稍后重试。', true);
  }

  const previousStaged =
    user.stagedAvatarFileId?.startsWith('cloud://') === true && user.stagedAvatarFileId !== fileId
      ? [user.stagedAvatarFileId]
      : [];
  const next: UserDocument = {
    ...user,
    stagedAvatarFileId: fileId,
    stagedAvatarToken: input.avatarToken,
    stagedAvatarExpiresAt: new Date(now.getTime() + STAGING_TTL_MS).toISOString(),
    stagedAvatarSha256: input.sha256,
    stagedAvatarSize: input.size,
    pendingFileDeletionIds: uniqueFileIds(user.pendingFileDeletionIds, previousStaged).filter(
      (candidate) => candidate !== fileId,
    ),
    version: user.version + 1,
    updatedAt: now.toISOString(),
  };
  if (await repository.updateUser(next, user.version)) return { avatarToken: input.avatarToken };

  const current = await repository.getUser(user.id);
  if (
    current?.stagedAvatarToken === input.avatarToken &&
    current.stagedAvatarFileId === fileId &&
    current.stagedAvatarSize === input.size &&
    current.stagedAvatarSha256 === input.sha256 &&
    validFutureTime(current.stagedAvatarExpiresAt, now)
  ) {
    return { avatarToken: input.avatarToken };
  }
  await discardStagedFile(repository, storage, clock, user.id, fileId);
  throw new BusinessError(
    'PROFILE_VERSION_CONFLICT',
    '个人资料刚刚发生变化，请重新选择头像。',
    true,
  );
}

export function assertAvatarContent(
  fileContent: Buffer,
  expectedSize: number,
  expectedSha256: string,
): void {
  assertAvatarMetadata(expectedSize, expectedSha256);
  const digest = createHash('sha256').update(fileContent).digest('hex');
  if (fileContent.byteLength !== expectedSize || digest !== expectedSha256) {
    throw new BusinessError('AVATAR_CONTENT_MISMATCH', '头像文件内容发生变化，请重新选择。');
  }
}

function assertAvatarMetadata(expectedSize: number, expectedSha256: string): void {
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 1 ||
    expectedSize > MAX_AVATAR_BYTES ||
    !/^[a-f0-9]{64}$/.test(expectedSha256)
  ) {
    throw new BusinessError('AVATAR_METADATA_INVALID', '头像文件信息无效。');
  }
}

export async function downloadAvatarSource(
  sourceUrl: string,
  dependencies: AvatarDownloadDependencies = defaultDownloadDependencies,
): Promise<Buffer> {
  return download(sourceUrl, dependencies, 0, Date.now() + REQUEST_TIMEOUT_MS);
}

async function download(
  sourceUrl: string,
  dependencies: AvatarDownloadDependencies,
  redirectCount: number,
  deadline: number,
): Promise<Buffer> {
  const url = validateSourceUrl(sourceUrl);
  const dnsBudget = Math.min(DNS_TIMEOUT_MS, deadline - Date.now());
  if (dnsBudget <= 0) {
    throw new BusinessError('AVATAR_SOURCE_UNAVAILABLE', '头像读取失败，请重新选择。', true);
  }
  const addresses = await withTimeout(dependencies.lookup(url.hostname), dnsBudget).catch(() => []);
  if (addresses.length === 0 || addresses.some((item) => !isPublicAddress(item.address))) {
    throw new BusinessError('AVATAR_SOURCE_INVALID', '头像临时地址无效。');
  }
  const selected = addresses[0]!;
  const requestBudget = deadline - Date.now();
  if (requestBudget <= 0) {
    throw new BusinessError('AVATAR_SOURCE_UNAVAILABLE', '头像读取失败，请重新选择。', true);
  }
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    let absoluteTimeout: ReturnType<typeof setTimeout> | null = null;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (absoluteTimeout !== null) clearTimeout(absoluteTimeout);
      reject(
        error instanceof BusinessError
          ? error
          : new BusinessError('AVATAR_SOURCE_UNAVAILABLE', '头像读取失败，请重新选择。', true),
      );
    };
    const request = dependencies.request(
      {
        family: selected.family,
        headers: { Host: url.host },
        hostname: selected.address,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        port: 443,
        rejectUnauthorized: true,
        servername: isIP(url.hostname) === 0 ? url.hostname : undefined,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.resume();
          const location = response.headers.location;
          if (location === undefined || redirectCount >= MAX_REDIRECTS) {
            fail(new BusinessError('AVATAR_SOURCE_INVALID', '头像临时地址重定向异常。'));
            return;
          }
          const redirected = new URL(location, url).toString();
          void download(redirected, dependencies, redirectCount + 1, deadline).then((value) => {
            if (settled) return;
            settled = true;
            if (absoluteTimeout !== null) clearTimeout(absoluteTimeout);
            resolve(value);
          }, fail);
          return;
        }
        if (status !== 200) {
          response.resume();
          fail(new BusinessError('AVATAR_SOURCE_UNAVAILABLE', '头像读取失败，请重新选择。', true));
          return;
        }
        const declaredLength = Number(response.headers['content-length'] ?? 0);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_AVATAR_BYTES) {
          response.destroy();
          fail(new BusinessError('AVATAR_TOO_LARGE', '头像文件不能超过 1 MB。'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.byteLength;
          if (size > MAX_AVATAR_BYTES) {
            response.destroy();
            fail(new BusinessError('AVATAR_TOO_LARGE', '头像文件不能超过 1 MB。'));
            return;
          }
          chunks.push(buffer);
        });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          if (absoluteTimeout !== null) clearTimeout(absoluteTimeout);
          resolve(Buffer.concat(chunks));
        });
        response.on('error', fail);
      },
    );
    request.setTimeout(requestBudget, () => {
      request.destroy(new Error('avatar source timeout'));
    });
    request.on('error', fail);
    absoluteTimeout = setTimeout(() => {
      request.destroy(new Error('avatar source absolute timeout'));
    }, requestBudget);
    request.end();
  });
}

export function validateSourceUrl(sourceUrl: string): URL {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new BusinessError('AVATAR_SOURCE_INVALID', '头像临时地址无效。');
  }
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.port.length > 0 && url.port !== '443') ||
    sourceUrl.length > 2048
  ) {
    throw new BusinessError('AVATAR_SOURCE_INVALID', '头像临时地址无效。');
  }
  url.hash = '';
  return url;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

const defaultDownloadDependencies: AvatarDownloadDependencies = {
  lookup: async (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
  request: (options, response) => httpsRequest(options, response),
};

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && parts[2] === 0) ||
    (a === 192 && b === 0 && parts[2] === 2) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 88 && parts[2] === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && parts[2] === 100) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    a >= 224
  );
}

function isPublicIpv6(address: string): boolean {
  const bytes = parseIpv6(address);
  if (bytes === null) return false;
  const allZero = bytes.every((byte) => byte === 0);
  const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  const ipv4Mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const ipv4Compatible = bytes.slice(0, 12).every((byte) => byte === 0);
  if (ipv4Mapped || ipv4Compatible) {
    return isPublicIpv4(bytes.slice(12).join('.'));
  }
  return !(
    allZero ||
    loopback ||
    (bytes[0]! & 0xe0) !== 0x20 || // only 2000::/3 is allocated for global unicast
    (bytes[0]! & 0xfe) === 0xfc || // fc00::/7 unique local
    (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) || // fe80::/10 link-local
    (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0) || // fec0::/10 site-local
    bytes[0] === 0xff || // multicast
    hasPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48) || // local-use NAT64
    hasPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96) || // standard NAT64
    hasPrefix(bytes, [0x20, 0x01, 0x00, 0x00], 32) || // Teredo
    hasPrefix(bytes, [0x20, 0x01, 0x00, 0x02, 0, 0], 48) || // benchmarking
    hasPrefix(bytes, [0x20, 0x01, 0x00, 0x10], 28) || // ORCHID
    hasPrefix(bytes, [0x20, 0x01, 0x00, 0x20], 28) || // ORCHIDv2
    hasPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32) || // documentation
    hasPrefix(bytes, [0x20, 0x02], 16) || // 6to4 can encapsulate private IPv4
    hasPrefix(bytes, [0x3f, 0xff, 0x00], 20) // documentation
  );
}

function parseIpv6(address: string): readonly number[] | null {
  const normalized = address
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('%')[0]!;
  const pieces = normalized.split('::');
  if (pieces.length > 2) return null;
  const left = parseIpv6Side(pieces[0] ?? '');
  const right = parseIpv6Side(pieces[1] ?? '');
  if (left === null || right === null) return null;
  const missing = 8 - left.length - right.length;
  if ((pieces.length === 1 && missing !== 0) || (pieces.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if (words.length !== 8) return null;
  return words.flatMap((word) => [word >> 8, word & 0xff]);
}

function parseIpv6Side(value: string): number[] | null {
  if (value.length === 0) return [];
  const pieces = value.split(':');
  const result: number[] = [];
  for (const [index, piece] of pieces.entries()) {
    if (piece.includes('.')) {
      if (index !== pieces.length - 1 || !isPublicOrReservedIpv4Syntax(piece)) return null;
      const octets = piece.split('.').map(Number) as [number, number, number, number];
      result.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      continue;
    }
    if (!/^[a-f0-9]{1,4}$/.test(piece)) return null;
    result.push(Number.parseInt(piece, 16));
  }
  return result;
}

function isPublicOrReservedIpv4Syntax(value: string): boolean {
  const octets = value.split('.').map(Number);
  return (
    octets.length === 4 &&
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
  );
}

function hasPrefix(bytes: readonly number[], prefix: readonly number[], bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  const remaining = bits % 8;
  if (remaining === 0) return true;
  const mask = (0xff << (8 - remaining)) & 0xff;
  return (bytes[fullBytes]! & mask) === (prefix[fullBytes]! & mask);
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('operation timed out')), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error('operation failed'));
      },
    );
  });
}

function validFutureTime(value: string | null | undefined, now: Date): boolean {
  const time = Date.parse(value ?? '');
  return Number.isFinite(time) && time > now.getTime();
}

function avatarBelongsToUser(fileId: string, userId: string): boolean {
  if (!fileId.startsWith('cloud://')) return false;
  const cloudPath = fileId.slice('cloud://'.length).split('/').slice(1);
  return cloudPath.length === 3 && cloudPath[0] === 'avatars' && cloudPath[1] === userId;
}

function uniqueFileIds(
  existing: readonly string[] | undefined,
  candidates: readonly string[],
): readonly string[] {
  return [...new Set([...(existing ?? []), ...candidates])].filter((value) =>
    value.startsWith('cloud://'),
  );
}

async function discardStagedFile(
  repository: Repository,
  storage: AvatarStagingStorage,
  clock: Clock,
  userId: string,
  fileId: string,
): Promise<void> {
  try {
    await storage.delete(fileId);
    return;
  } catch {
    // Persist the orphan before surfacing the original staging failure.
  }
  if (!fileId.startsWith('cloud://')) return;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await repository.getUser(userId);
    if (current === null) return;
    if (current.pendingFileDeletionIds?.includes(fileId) === true) return;
    const queued: UserDocument = {
      ...current,
      pendingFileDeletionIds: uniqueFileIds(current.pendingFileDeletionIds, [fileId]),
      version: current.version + 1,
      updatedAt: clock.now().toISOString(),
    };
    if (await repository.updateUser(queued, current.version)) return;
  }
  throw new BusinessError('AVATAR_CLEANUP_FAILED', '头像暂存未完成，清理任务将在稍后重试。', true);
}
