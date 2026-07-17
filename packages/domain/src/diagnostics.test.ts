import { describe, expect, it } from 'vitest';

import { redactedRuntimeError, safeDiagnosticCode } from './diagnostics.js';

describe('safe cloud diagnostics', () => {
  it('keeps bounded machine codes used by Node and WeChat', () => {
    expect(safeDiagnosticCode({ errCode: -501000 })).toBe('-501000');
    expect(safeDiagnosticCode({ code: 'DATABASE_TIMEOUT' })).toBe('DATABASE_TIMEOUT');
    expect(
      safeDiagnosticCode(Object.assign(new Error('private message'), { code: 'ETIMEDOUT' })),
    ).toBe('ETIMEDOUT');
  });

  it('rejects messages, URLs, line breaks, and oversized diagnostic fields', () => {
    expect(safeDiagnosticCode({ code: 'bad\nhttps://private.test/token' })).toBe('unknown');
    expect(safeDiagnosticCode({ code: 'privateTokenWithoutPunctuation' })).toBe('unknown');
    expect(safeDiagnosticCode({ errCode: 'x'.repeat(65) })).toBe('unknown');
    expect(safeDiagnosticCode('https://private.test/token')).toBe('unknown');
  });

  it('creates a new generic runtime error without retaining the original message or cause', () => {
    const original = Object.assign(new Error('private URL https://private.test/token'), {
      code: 'STORAGE_FAILED',
      request: { authorization: 'private' },
    });
    const redacted = redactedRuntimeError(original, 'cloud task failed');

    expect(redacted).toMatchObject({ code: 'STORAGE_FAILED', message: 'cloud task failed' });
    expect(redacted).not.toHaveProperty('cause');
    expect(JSON.stringify(redacted)).not.toContain('private');
  });
});
