import { describe, expect, it } from 'vitest';

import { formatCents, parseYuanToCents } from './money.js';

describe('money', () => {
  it.each([
    ['0', 0],
    ['0.01', 1],
    ['12.3', 1230],
    ['9999999.00', 999_999_900],
  ])('parses %s to integer cents', (input, expected) => {
    expect(parseYuanToCents(input)).toBe(expected);
  });

  it.each(['', '.1', '01', '1.', '1.001', '-1', '10000000', 'NaN'])('rejects %s', (input) => {
    expect(parseYuanToCents(input)).toBeNull();
  });

  it('formats cents without floating point arithmetic', () => {
    expect(formatCents(1_234_567)).toBe('¥12,345.67');
    expect(formatCents(-1)).toBe('-¥0.01');
  });
});
