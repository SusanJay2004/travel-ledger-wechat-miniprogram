import { describe, expect, it } from 'vitest';

import { isDeletedBillRestorable } from './bill-retention';

describe('deleted bill retention', () => {
  const now = Date.parse('2026-08-16T00:00:00.000Z');

  it('allows restoration strictly within 30 days', () => {
    expect(isDeletedBillRestorable('2026-07-17T00:00:00.001Z', now)).toBe(true);
    expect(isDeletedBillRestorable('2026-07-17T00:00:00.000Z', now)).toBe(false);
  });

  it('fails closed for active, malformed, and future timestamps', () => {
    expect(isDeletedBillRestorable(null, now)).toBe(false);
    expect(isDeletedBillRestorable('invalid', now)).toBe(false);
    expect(isDeletedBillRestorable('2026-08-17T00:00:00.000Z', now)).toBe(false);
  });
});
