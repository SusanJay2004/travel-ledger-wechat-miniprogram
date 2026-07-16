import type { Cents } from './types.js';

const MONEY_INPUT = /^(?:0|[1-9]\d{0,6})(?:\.(\d{1,2}))?$/;

export function parseYuanToCents(value: string): Cents | null {
  const normalized = value.trim();
  const match = MONEY_INPUT.exec(normalized);
  if (match === null) return null;

  const [yuanPart = '0', fractionPart = ''] = normalized.split('.');
  const cents = Number(yuanPart) * 100 + Number(fractionPart.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

export function formatCents(cents: Cents): string {
  assertCents(cents, true);
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  const yuan = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, '0');
  return `${sign}¥${yuan.toLocaleString('en-US')}.${fraction}`;
}

export function assertCents(cents: Cents, allowNegative = false): void {
  if (!Number.isSafeInteger(cents) || (!allowNegative && cents < 0)) {
    throw new TypeError('Amount must be a safe integer number of cents.');
  }
}
