import { describe, expect, it } from 'vitest';

import { assertScheduledTrigger } from './trigger-auth';

describe('maintenance trigger authentication', () => {
  it('accepts an official scheduled trigger context', () => {
    expect(() => assertScheduledTrigger({ SOURCE: 'wx_trigger' })).not.toThrow();
  });

  it.each([
    {},
    { SOURCE: '' },
    { SOURCE: 'wx_cloud_call' },
    { OPENID: 'attacker-openid' },
    { OPENID: 'attacker-openid', SOURCE: 'wx_cloud_call' },
  ])('rejects a non-trigger context %#', (context) => {
    expect(() => assertScheduledTrigger(context)).toThrow(
      'maintenance function only accepts wx_trigger events',
    );
  });
});
