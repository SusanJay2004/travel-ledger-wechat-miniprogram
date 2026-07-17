import { readFileSync } from 'node:fs';
import process from 'node:process';

const cloudFunctions = ['api', 'avatar-review', 'maintenance', 'backup'];
const rootLock = readJson('package-lock.json');
const deploymentTrees = [];

for (const name of cloudFunctions) {
  const root = `cloudfunctions/${name}`;
  const manifest = readJson(`${root}/package.json`);
  const lock = readJson(`${root}/package-lock.json`);
  const lockedRoot = lock.packages?.[''];
  const workspaceRoot = rootLock.packages?.[root];

  assert(lock.lockfileVersion === 3, `${root} 必须使用 npm lockfileVersion 3`);
  assert(lockedRoot?.name === manifest.name, `${root} 独立 lockfile 的包名不一致`);
  assert(workspaceRoot?.name === manifest.name, `${root} 根 workspace lock 的包名不一致`);

  const dependencies = manifest.dependencies ?? {};
  assert(Object.keys(dependencies).length > 0, `${root} 缺少生产依赖`);
  for (const [dependency, declaredVersion] of Object.entries(dependencies)) {
    assert(
      typeof declaredVersion === 'string' && isExactVersion(declaredVersion),
      `${root} 的 ${dependency} 必须使用精确版本，不能使用范围`,
    );
    assert(
      lockedRoot.dependencies?.[dependency] === declaredVersion,
      `${root} 的独立 lockfile 未锁定 ${dependency}@${declaredVersion}`,
    );
    assert(
      workspaceRoot.dependencies?.[dependency] === declaredVersion,
      `${root} 的根 workspace lock 未锁定 ${dependency}@${declaredVersion}`,
    );
    assert(
      lock.packages?.[`node_modules/${dependency}`]?.version === declaredVersion,
      `${root} 的独立部署树未解析到 ${dependency}@${declaredVersion}`,
    );
  }

  deploymentTrees.push({
    name,
    axios: packageVersion(lock, 'axios'),
    cloudbase: packageVersion(lock, '@cloudbase/node-sdk'),
    database: packageVersion(lock, '@cloudbase/database'),
    sdk: packageVersion(lock, 'wx-server-sdk'),
    ws: packageVersion(lock, 'ws'),
  });
}

const expectedTree = JSON.stringify({ ...deploymentTrees[0], name: undefined });
for (const tree of deploymentTrees.slice(1)) {
  assert(
    JSON.stringify({ ...tree, name: undefined }) === expectedTree,
    `${tree.name} 的独立部署依赖树与其他云函数不一致`,
  );
}

const summary = deploymentTrees[0];
process.stdout.write(
  `云函数部署锁校验通过：4 个函数统一使用 wx-server-sdk ${summary.sdk}、CloudBase ${summary.cloudbase}、Axios ${summary.axios}、Database ${summary.database}、ws ${summary.ws}。\n`,
);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取或解析 ${path}`, { cause: error });
  }
}

function packageVersion(lock, name) {
  const version = lock.packages?.[`node_modules/${name}`]?.version;
  assert(typeof version === 'string', `独立部署树缺少 ${name}`);
  return version;
}

function isExactVersion(value) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
