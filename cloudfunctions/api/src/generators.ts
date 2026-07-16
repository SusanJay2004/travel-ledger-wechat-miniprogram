import { randomBytes, randomUUID } from 'node:crypto';

import { PUBLIC_ID_ALPHABET } from '@travel-ledger/domain';

import type { Clock, IdGenerator } from './models';

export const systemClock: Clock = {
  now: () => new Date(),
};

export const secureIdGenerator: IdGenerator = {
  entityId(prefix: string) {
    return `${prefix}_${randomUUID().replaceAll('-', '')}`;
  },
  publicId() {
    const bytes = randomBytes(10);
    return [...bytes].map((byte) => PUBLIC_ID_ALPHABET[byte % PUBLIC_ID_ALPHABET.length]).join('');
  },
  sceneToken() {
    return randomBytes(15).toString('base64url');
  },
};
