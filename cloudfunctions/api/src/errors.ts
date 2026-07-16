export class BusinessError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'BusinessError';
  }
}

export function assertBusiness(
  condition: boolean,
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): asserts condition {
  if (!condition) throw new BusinessError(code, message, false, details);
}
