import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('visual accessibility tokens', () => {
  it('keeps core text tokens at WCAG AA contrast on primary surfaces', () => {
    const surfaces = ['#f7f4ec', '#fffcf6', '#fff0ed', '#eceae4', '#eae7df'];
    for (const foreground of ['#27312f', '#5f6a67', '#a53838', '#7f4e04']) {
      for (const background of surfaces) {
        expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrastRatio('#ffffff', '#0f6e65')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#0f6e65', '#dff1ed')).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps base button targets at least 88rpx', () => {
    const styles = readFileSync(resolve(process.cwd(), 'miniprogram/app.wxss'), 'utf8');
    expect(styles).toMatch(/\.primary-button,[\s\S]*?min-height:\s*88rpx/);
  });
});

function contrastRatio(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05);
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return (linear[0] ?? 0) * 0.2126 + (linear[1] ?? 0) * 0.7152 + (linear[2] ?? 0) * 0.0722;
}
