import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

interface AppConfig {
  tabBar: {
    list: readonly {
      iconPath: string;
      selectedIconPath: string;
    }[];
  };
}

describe('brand assets', () => {
  it('keeps every tab icon present, compact, transparent and 81px square', () => {
    const app = JSON.parse(
      readFileSync(resolve(process.cwd(), 'miniprogram/app.json'), 'utf8'),
    ) as AppConfig;
    const paths = app.tabBar.list.flatMap((item) => [item.iconPath, item.selectedIconPath]);

    expect(paths).toHaveLength(6);
    expect(new Set(paths).size).toBe(6);
    for (const path of paths) {
      const absolutePath = resolve(process.cwd(), 'miniprogram', path);
      const bytes = readFileSync(absolutePath);
      expect(readPngHeader(bytes)).toEqual({ bitDepth: 8, colorType: 6, height: 81, width: 81 });
      expect(statSync(absolutePath).size).toBeLessThan(40 * 1024);
    }
  });

  it('provides a 1024px square RGB application avatar', () => {
    const bytes = readFileSync(resolve(process.cwd(), 'assets/brand/app-icon.png'));
    expect(readPngHeader(bytes)).toEqual({ bitDepth: 8, colorType: 2, height: 1024, width: 1024 });
  });
});

function readPngHeader(bytes: Buffer): {
  bitDepth: number;
  colorType: number;
  height: number;
  width: number;
} {
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  return {
    bitDepth: bytes.readUInt8(24),
    colorType: bytes.readUInt8(25),
    height: bytes.readUInt32BE(20),
    width: bytes.readUInt32BE(16),
  };
}
