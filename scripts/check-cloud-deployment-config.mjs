import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

const expectedFunctions = new Map([
  ['api', { memorySize: 256, timeout: 30, trigger: null }],
  ['avatar-review', { memorySize: 256, timeout: 30, trigger: null }],
  [
    'maintenance',
    {
      memorySize: 512,
      timeout: 900,
      trigger: { name: 'daily-maintenance', config: '0 30 3 * * * *' },
    },
  ],
  [
    'backup',
    {
      memorySize: 512,
      timeout: 900,
      trigger: { name: 'daily-backup', config: '0 30 4 * * * *' },
    },
  ],
]);

const config = readJson('cloudbaserc.json');
assert(
  config.$schema === 'https://static.cloudbase.net/cli/cloudbaserc.schema.json',
  'cloudbaserc.json 必须引用官方 schema',
);
assert(config.version === '2.0', 'cloudbaserc.json 必须锁定配置版本 2.0');
assert(
  config.envId === '{{env.CLOUDBASE_ENV_ID}}',
  '云环境 ID 必须来自 CLOUDBASE_ENV_ID，不能写入仓库',
);
assert(config.functionRoot === './cloudfunctions', '云函数根目录必须是 ./cloudfunctions');
assert(Array.isArray(config.functions), 'cloudbaserc.json 缺少 functions');
assert(config.functions.length === expectedFunctions.size, '云函数部署数量不一致');

for (const fn of config.functions) {
  const expected = expectedFunctions.get(fn.name);
  assert(expected !== undefined, `存在未审核的云函数配置：${String(fn.name)}`);
  assert(fn.type === 'Event', `${fn.name} 必须是事件云函数`);
  assert(fn.runtime === 'Nodejs20.19', `${fn.name} 必须锁定 Nodejs20.19`);
  assert(fn.handler === 'index.main', `${fn.name} 必须使用兼容微信开发者工具的根入口`);
  assert(fn.timeout === expected.timeout, `${fn.name} 超时时间不一致`);
  assert(fn.memorySize === expected.memorySize, `${fn.name} 内存配置不一致`);
  assert(fn.installDependency === true, `${fn.name} 必须云端安装依赖`);
  assert(fn.isWaitInstall === true, `${fn.name} 必须等待云端依赖安装完成`);
  assert(
    Array.isArray(fn.ignore) &&
      fn.ignore.includes('node_modules') &&
      fn.ignore.includes('src') &&
      !fn.ignore.some((pattern) => pattern.includes('dist') || pattern.includes('package-lock')),
    `${fn.name} 上传过滤规则不能排除构建产物或 lockfile`,
  );
  assert(existsSync(`cloudfunctions/${fn.name}/package.json`), `${fn.name} 缺少 package.json`);
  assert(
    existsSync(`cloudfunctions/${fn.name}/package-lock.json`),
    `${fn.name} 缺少 package-lock.json`,
  );
  assert(existsSync(`cloudfunctions/${fn.name}/index.js`), `${fn.name} 缺少根入口 index.js`);
  const manifest = readJson(`cloudfunctions/${fn.name}/package.json`);
  assert(manifest.main === 'index.js', `${fn.name} 的 package.json.main 必须指向根入口`);
  assert(
    readFileSync(`cloudfunctions/${fn.name}/index.js`, 'utf8').includes(
      "require('./dist/index.js')",
    ),
    `${fn.name} 的根入口必须转发到经过门禁的构建产物`,
  );

  if (expected.trigger === null) {
    assert(fn.triggers === undefined, `${fn.name} 不应配置定时触发器`);
    continue;
  }
  const localConfig = readJson(`cloudfunctions/${fn.name}/config.json`);
  assert(Array.isArray(fn.triggers) && fn.triggers.length === 1, `${fn.name} 必须只有一个触发器`);
  const trigger = fn.triggers[0];
  assert(trigger.name === expected.trigger.name, `${fn.name} 触发器名称不一致`);
  assert(trigger.type === 'timer', `${fn.name} 触发器必须为 timer`);
  assert(trigger.config === expected.trigger.config, `${fn.name} Cron 不一致`);
  assert(
    JSON.stringify(localConfig.triggers) === JSON.stringify(fn.triggers),
    `${fn.name} 的开发者工具与 CloudBase CLI 触发器配置不一致`,
  );
}

const backupSource = readFileSync('cloudfunctions/backup/src/index.ts', 'utf8');
const leaseMinutes = /BACKUP_LEASE_MS\s*=\s*(\d+)\s*\*\s*60\s*\*\s*1000/.exec(backupSource)?.[1];
assert(leaseMinutes !== undefined, '无法读取备份租约长度');
assert(
  Number(leaseMinutes) * 60 > expectedFunctions.get('backup').timeout,
  '备份租约必须严格长于平台最大执行时间',
);

process.stdout.write(
  '云部署配置校验通过：4 个事件函数锁定 Nodejs20.19，备份/维护超时 900 秒，备份租约严格更长。\n',
);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取或解析 ${path}`, { cause: error });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
