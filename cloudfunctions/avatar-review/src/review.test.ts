import { describe, expect, it } from 'vitest';

import { assertReviewPushSource, parseAvatarReviewEvent } from './review';

describe('avatar review event parsing', () => {
  it('accepts only an explicit successful pass result', () => {
    expect(
      parseAvatarReviewEvent({
        MsgType: 'event',
        Event: 'wxa_media_check',
        trace_id: 'trace-123456',
        errcode: 0,
        result: { suggest: 'pass', label: 100 },
      }),
    ).toEqual({ accepted: true, label: 100, traceId: 'trace-123456' });

    for (const event of [
      { errcode: 0, result: { suggest: 'risky', label: 20002 } },
      { errcode: 0, result: { suggest: 'review', label: 21000 } },
      { errcode: -1, result: { suggest: 'pass', label: 100 } },
    ]) {
      expect(
        parseAvatarReviewEvent({
          MsgType: 'event',
          Event: 'wxa_media_check',
          trace_id: 'trace-123456',
          ...event,
        }).accepted,
      ).toBe(false);
    }
  });

  it('rejects other push types and missing trace ids', () => {
    expect(() => parseAvatarReviewEvent({ Event: 'forged', trace_id: 'trace-123456' })).toThrow(
      'only accepts wxa_media_check',
    );
    expect(() => parseAvatarReviewEvent({ MsgType: 'event', Event: 'wxa_media_check' })).toThrow(
      'missing trace_id',
    );
  });

  it('rejects every source a client or another function can actively invoke', () => {
    for (const source of ['wx_client', 'wx_devtools', 'wx_http', 'scf', 'wx_client, scf']) {
      expect(() => assertReviewPushSource(source)).toThrow('rejects callable sources');
    }
    expect(() => assertReviewPushSource(undefined)).not.toThrow();
    expect(() => assertReviewPushSource('wx_unknown')).not.toThrow();
  });
});
