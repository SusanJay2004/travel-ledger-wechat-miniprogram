import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPrivateCloudConfig, validatePrivateCloudConfig } from './cloud-private-config.mjs';
import { parseCloudConfigDiff } from './deploy-cloud-functions.mjs';
import {
  buildPrivateProjectConfig,
  compareMiniprogramTrees,
  renderPrivateCloudEnvironment,
} from './miniprogram-private-config.mjs';

const publicConfig = JSON.parse(readFileSync('cloudbaserc.json', 'utf8'));
const validTestAppId = ['wx', '0123456789abcdef'].join('');

describe('private cloud deployment config', () => {
  it('builds an isolated solo development config without exposing acknowledgements', () => {
    const config = buildPrivateCloudConfig(publicConfig, {
      CLOUDBASE_ENV_ID: 'example-development-env',
      CLOUD_DEPLOYMENT_STAGE: 'development',
      PRODUCT_MODE: 'solo',
      MINIPROGRAM_ENV_VERSION: 'develop',
      CONTENT_SECURITY_MODE: 'disabled',
    });

    expect(config.envId).toBe('example-development-env');
    expect(config.functions.find((item) => item.name === 'api')?.envVariables).toEqual({
      CLOUD_DEPLOYMENT_STAGE: 'development',
      CONTENT_SECURITY_MODE: 'disabled',
      MINIPROGRAM_ENV_VERSION: 'develop',
      PRODUCT_MODE: 'solo',
    });
    expect(config.functions.find((item) => item.name === 'backup')?.envVariables).toEqual({});
    expect(JSON.stringify(config)).not.toContain('ALLOW_');
  });

  it('requires explicit platform approval before preparing collaboration mode', () => {
    expect(() =>
      buildPrivateCloudConfig(publicConfig, {
        CLOUDBASE_ENV_ID: 'example-development-env',
        CLOUD_DEPLOYMENT_STAGE: 'development',
        PRODUCT_MODE: 'collaboration',
        MINIPROGRAM_ENV_VERSION: 'develop',
      }),
    ).toThrow(/ALLOW_COLLABORATION_DEPLOY/);
  });

  it('requires an independent acknowledgement for production', () => {
    expect(() =>
      buildPrivateCloudConfig(publicConfig, {
        CLOUDBASE_ENV_ID: 'example-production-env',
        CLOUD_DEPLOYMENT_STAGE: 'production',
        PRODUCT_MODE: 'solo',
        MINIPROGRAM_ENV_VERSION: 'release',
      }),
    ).toThrow(/ALLOW_PRODUCTION_DEPLOY/);
  });

  it('rejects disabled content security outside a develop-only development environment', () => {
    expect(() =>
      buildPrivateCloudConfig(publicConfig, {
        CLOUDBASE_ENV_ID: 'example-development-env',
        CLOUD_DEPLOYMENT_STAGE: 'development',
        PRODUCT_MODE: 'solo',
        MINIPROGRAM_ENV_VERSION: 'trial',
        CONTENT_SECURITY_MODE: 'disabled',
      }),
    ).toThrow(/只有开发云环境/);
  });

  it('rejects crossed mini program versions between development and production environments', () => {
    expect(() =>
      buildPrivateCloudConfig(publicConfig, {
        CLOUDBASE_ENV_ID: 'example-development-env',
        CLOUD_DEPLOYMENT_STAGE: 'development',
        PRODUCT_MODE: 'solo',
        MINIPROGRAM_ENV_VERSION: 'trial',
      }),
    ).toThrow(/develop/);
    expect(() =>
      buildPrivateCloudConfig(publicConfig, {
        CLOUDBASE_ENV_ID: 'example-production-env',
        CLOUD_DEPLOYMENT_STAGE: 'production',
        PRODUCT_MODE: 'solo',
        MINIPROGRAM_ENV_VERSION: 'develop',
        ALLOW_PRODUCTION_DEPLOY: 'PRODUCTION_ENV_REVIEWED',
      }),
    ).toThrow(/生产云环境/);
  });

  it('rejects unreviewed environment variables and template drift', () => {
    const config = buildPrivateCloudConfig(publicConfig, {
      CLOUDBASE_ENV_ID: 'example-development-env',
      CLOUD_DEPLOYMENT_STAGE: 'development',
      PRODUCT_MODE: 'solo',
      MINIPROGRAM_ENV_VERSION: 'develop',
    });
    config.functions.find((item) => item.name === 'api').envVariables.UNREVIEWED_SECRET = 'x';
    expect(() => validatePrivateCloudConfig(config, publicConfig)).toThrow(/未审核的环境变量/);

    delete config.functions.find((item) => item.name === 'api').envVariables.UNREVIEWED_SECRET;
    config.functions.find((item) => item.name === 'backup').timeout = 30;
    expect(() => validatePrivateCloudConfig(config, publicConfig)).toThrow(/不得偏离公开模板/);
  });
});

describe('cloud configuration diff parsing', () => {
  it('extracts the JSON array without exposing banner text', () => {
    expect(
      parseCloudConfigDiff(
        'CloudBase CLI 3.6.3\n[{"name":"api","status":"unchanged","hasChanges":false}]\n',
      ),
    ).toEqual([{ name: 'api', status: 'unchanged', hasChanges: false }]);
  });

  it('fails closed when the CLI does not return valid JSON', () => {
    expect(() => parseCloudConfigDiff('configuration differs')).toThrow(/JSON/);
  });
});

describe('private mini program configuration', () => {
  it('keeps local developer settings while binding the ignored source root and real AppID', () => {
    expect(
      buildPrivateProjectConfig({ setting: { compileHotReLoad: true } }, validTestAppId),
    ).toEqual({
      appid: validTestAppId,
      miniprogramRoot: 'miniprogram-private/',
      setting: { compileHotReLoad: true },
      srcMiniprogramRoot: 'miniprogram-private/',
    });
  });

  it('renders the private environment module without changing public sources', () => {
    expect(renderPrivateCloudEnvironment('example-development-env')).toBe(
      '// Generated locally; this directory is ignored by Git.\n' +
        'export const cloudEnvironmentId = "example-development-env";\n',
    );
    expect(readFileSync('miniprogram/config/cloud.ts', 'utf8')).toMatch(
      /cloudEnvironmentId\s*=\s*''/,
    );
    expect(readFileSync('miniprogram/app.ts', 'utf8')).toContain(
      'wx.cloud.init({ env: cloudEnvironmentId, traceUser: true })',
    );
  });

  it('rejects malformed AppIDs and environment IDs', () => {
    expect(() => buildPrivateProjectConfig({}, 'touristappid')).toThrow(/APP_ID/);
    expect(() => renderPrivateCloudEnvironment('{{env.ID}}')).toThrow(/ENV_ID/);
  });

  it('detects stale, missing, and unexpected files in the ignored mini program mirror', () => {
    const root = mkdtempSync(join(tmpdir(), 'travel-ledger-private-mirror-'));
    const publicRoot = join(root, 'public');
    const privateRoot = join(root, 'private');
    mkdirSync(publicRoot);
    mkdirSync(privateRoot);
    try {
      writeFileSync(join(publicRoot, 'same.ts'), 'same');
      writeFileSync(join(privateRoot, 'same.ts'), 'same');
      writeFileSync(join(publicRoot, 'changed.ts'), 'current');
      writeFileSync(join(privateRoot, 'changed.ts'), 'stale');
      writeFileSync(join(publicRoot, 'missing.ts'), 'missing');
      writeFileSync(join(privateRoot, 'extra.ts'), 'extra');
      expect(compareMiniprogramTrees(publicRoot, privateRoot)).toEqual([
        '内容不一致 changed.ts',
        '私有副本多出 extra.ts',
        '私有副本缺少 missing.ts',
      ]);
      expect(
        compareMiniprogramTrees(publicRoot, privateRoot, new Set(['changed.ts'])),
      ).not.toContain('内容不一致 changed.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
