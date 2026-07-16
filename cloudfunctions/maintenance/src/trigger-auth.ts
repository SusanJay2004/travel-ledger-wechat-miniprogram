export interface TriggerContext {
  OPENID?: string;
  SOURCE?: string;
}

export function assertScheduledTrigger(context: TriggerContext): void {
  if (context.SOURCE !== 'wx_trigger') {
    throw new Error('maintenance function only accepts wx_trigger events');
  }
}
