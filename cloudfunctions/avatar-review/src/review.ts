export interface AvatarReviewEvent {
  Event?: unknown;
  MsgType?: unknown;
  errcode?: unknown;
  result?: unknown;
  trace_id?: unknown;
}

export interface ParsedAvatarReview {
  accepted: boolean;
  label: number | null;
  traceId: string;
}

export function assertReviewPushSource(source: string | undefined): void {
  const chain = (source ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (chain.some((item) => ['wx_client', 'wx_devtools', 'wx_http', 'scf'].includes(item))) {
    throw new Error('avatar review function rejects callable sources');
  }
}

export function parseAvatarReviewEvent(event: AvatarReviewEvent): ParsedAvatarReview {
  if (event.MsgType !== 'event' || event.Event !== 'wxa_media_check') {
    throw new Error('avatar review function only accepts wxa_media_check events');
  }
  if (typeof event.trace_id !== 'string' || event.trace_id.length < 8) {
    throw new Error('avatar review event is missing trace_id');
  }
  const result = isRecord(event.result) ? event.result : {};
  const suggest = typeof result['suggest'] === 'string' ? result['suggest'] : '';
  const label = Number.isSafeInteger(result['label']) ? (result['label'] as number) : null;
  return {
    accepted: Number(event.errcode) === 0 && suggest === 'pass',
    label,
    traceId: event.trace_id,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
