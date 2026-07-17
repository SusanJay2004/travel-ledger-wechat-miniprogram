# 依赖安全审计记录

审计日期：2026-07-17。

## 当前结论

- 项目使用微信官方 `wx-server-sdk 4.0.2`；2026-07-17 21:14（北京时间）再次查询 npm registry，`latest` 仍为 4.0.2，`beta` 仍为 4.0.3-beta.1。
- 2026-07-17 再次核对 registry：CloudBase 虽已发布 `@cloudbase/node-sdk 3.18.5` 和 4.0.3，但两者仍固定使用 `axios 0.27.2`；`wx-server-sdk 4.0.2` 又精确固定 3.17.2，因此不能用受支持的小版本更新消除公告。
- 2026-07-17 15:26（北京时间）发布的 `wx-server-sdk 4.0.3-beta.1` 已改为固定 `@cloudbase/node-sdk 3.18.5`，但后者仍固定 `axios 0.27.2` 和 `@cloudbase/database 1.4.3`；数据库继续固定 `lodash.set 4.3.2`、`lodash.unset 4.5.2`。该 beta 既未解除公告，也不是 npm `latest`，因此不进入生产依赖。
- 对微信与 CloudBase 两个官方 GitHub 仓库进行只读 issue 搜索，未发现与当前 Axios/Lodash 公告对应的公开处置结论或受支持的覆盖方案；后续仍以 npm 正式版和官方书面回复为准。
- 干净执行 `npm ci` 后，`npm audit` 仍报告 6 个公告（5 high、1 moderate），全部来自官方 SDK 的依赖树。
- 公开仓库启用 Dependabot 后，GitHub 按根 lockfile 与四个云函数 lockfile 分别报告相同依赖路径：2026-07-17 共 120 条开放报告，覆盖 5 份 manifest；按 GHSA 去重后为 24 个公告（11 high、12 medium、1 low）。这与 npm 按漏洞依赖节点汇总为 6 项的口径不同，不代表突然新增了 120 个独立漏洞，也不能因此关闭或忽略告警。
- 其中 3 个 high 来自 `@cloudbase/node-sdk 3.17.2 -> axios 0.27.2`；另外 2 个 high 与 1 个 moderate 来自 CloudBase 数据库固定的 `lodash.set 4.3.2` 与 `lodash.unset 4.5.2`。
- 尝试降级到审计建议的 `wx-server-sdk 2.5.3` 后，结果恶化为 16 个漏洞（含 3 个 critical），且带来旧版类型兼容问题，因此已否决。
- 尝试通过根级 `overrides` 跨主版本替换 Axios，`npm ls` 与锁文件证明嵌套 `axios 0.27.2` 仍然存在，因此没有把无效配置保留在仓库。
- 尝试使用本地兼容包替换 Lodash 单函数依赖，发现 npm workspace 与云函数独立安装会产生去重和相对路径不一致，无法证明线上部署可靠，因此也已回退。
- 四个云函数现分别保留独立 `package-lock.json`，直接依赖精确锁定为 `wx-server-sdk 4.0.2` 和无公告的可选 peer `ws 8.21.1`；后者消除官方 CloudBase 适配器冷启动时的“缺少依赖 ws”日志。2026-07-17 在四个隔离目录分别执行 `npm ci --omit=dev` 并加载 SDK 成功，均解析为 CloudBase 3.17.2、Axios 0.27.2、Database 1.4.3。`security:cloud-locks` 会阻止 manifest、独立 lockfile 与根 workspace lock 漂移，但不会把上游公告视为已修复。
- Dependabot 的开发依赖组只合并 minor/patch 更新；破坏性 major 更新逐项建 PR。首个将 TypeScript 7、ESLint 10、Vitest 4 等五个 major 混合升级的 PR 无法通过 `npm ci`（TypeScript 7 超出 `typescript-eslint 8.64.0` 的 `<6.1.0` peer 范围），已明确拒绝，禁止使用 `--force` 或 `--legacy-peer-deps` 绕过。

## 风险边界

业务代码不接受用户提供的任意 URL，不对外开放 HTTP API，也不直接调用 Axios；所有外部请求由微信 SDK 指向平台服务。服务端还实施鉴权、输入白名单、请求幂等、版本条件、限流和内容安全检查。这些措施降低了部分 SSRF 和原型污染利用面，但不能把上游依赖公告视为已修复。

## 发布门禁

生产发布前必须满足以下任一条件：

1. 微信发布不再包含上述高危依赖的新 SDK，升级后 `npm audit --audit-level=high` 通过，并完成云端回归；或
2. 微信/CloudBase 官方提供与当前云函数场景对应的书面风险说明或受支持的安全修复方案，经运营者留档确认。

CI 继续运行 `npm audit --audit-level=critical`，防止新增 critical 漏洞；高危报告单独输出并作为发布清单的人工阻断项。不得使用 `npm audit fix --force` 自动降级或做未经验证的跨主版本替换。
