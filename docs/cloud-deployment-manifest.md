# 云开发部署清单

这是部署操作清单，不包含真实 AppID、环境 ID、密钥或用户数据。

## 集合与客户端权限

规则模板位于 `config/cloud-database-rules.json` 和 `config/cloud-storage-rules.json`。微信控制台按集合分别保存数据库规则，因此部署时逐项复制模板并执行本清单的允许/拒绝烟测；模板存在不等于云端已生效。

除 `sync_events` 外，下列集合全部设置为客户端不可读、不可写：

`users`、`trips`、`friend_requests`、`friendships`、`blocks`、`notifications`、`trip_invitations`、`audit_logs`、`idempotency_records`、`rate_limit_records`、`backup_manifests`。

`sync_events` 使用：

```json
{
  "read": "auth.openid == get(`database.users.${doc.userId}`).openId",
  "write": false
}
```

客户端监听必须显式查询 `{ userId, tripId }`。规则通过私有 `users` 文档校验当前微信身份，不在客户端可读的同步记录里保存 `OpenID`；微信安全规则要求查询条件包含 `get()` 路径使用的 `userId`。

## 索引

`config/cloud-database-indexes.json` 是索引的机器可读权威目录；下表必须与它完全一致。组合索引遵循官方前缀规则，因此不重复创建已经由前缀覆盖的单字段索引。平台自动提供的 `_id` 主键索引不在表中重复登记；带精确 `_id` 的乐观并发条件先用主键定位唯一文档，再校验版本和状态。目录还保存当前 56 个生产 `.where/.orderBy` 调用的 AST 审计指纹；查询代码变化会让 `security:cloud-indexes` 失败，必须重新逐项核对并显式更新指纹。

在开发环境先创建并用实际查询验证命中情况，确认后逐项复制到生产环境：

<!-- cloud-indexes:start -->

| 集合                  | 类型 | 字段顺序                                    |
| --------------------- | ---- | ------------------------------------------- |
| `users`               | 唯一 | `openId ASC`                                |
| `users`               | 唯一 | `publicId ASC`                              |
| `users`               | 普通 | `qrSceneToken ASC`                          |
| `users`               | 普通 | `pendingAvatarReviewId ASC`                 |
| `users`               | 普通 | `pendingAvatarExpiresAt ASC, _id ASC`       |
| `users`               | 普通 | `stagedAvatarExpiresAt ASC, _id ASC`        |
| `users`               | 普通 | `status ASC, _id ASC`                       |
| `trips`               | 普通 | `memberIds ASC, _id ASC`                    |
| `friend_requests`     | 唯一 | `pendingKey ASC`                            |
| `friend_requests`     | 普通 | `fromUserId ASC, toUserId ASC, status ASC`  |
| `friend_requests`     | 普通 | `toUserId ASC`                              |
| `friend_requests`     | 普通 | `expiresAt ASC`                             |
| `friendships`         | 普通 | `userIds ASC`                               |
| `blocks`              | 普通 | `blockerUserId ASC, blockedUserId ASC`      |
| `blocks`              | 普通 | `blockedUserId ASC`                         |
| `notifications`       | 普通 | `userId ASC`                                |
| `notifications`       | 普通 | `actorUserId ASC`                           |
| `notifications`       | 普通 | `tripId ASC`                                |
| `notifications`       | 普通 | `requestId ASC`                             |
| `notifications`       | 普通 | `invitationId ASC`                          |
| `trip_invitations`    | 唯一 | `pendingKey ASC`                            |
| `trip_invitations`    | 普通 | `tripId ASC, inviteeUserId ASC, status ASC` |
| `trip_invitations`    | 普通 | `inviterUserId ASC`                         |
| `trip_invitations`    | 普通 | `inviteeUserId ASC`                         |
| `trip_invitations`    | 普通 | `expiresAt ASC`                             |
| `sync_events`         | 普通 | `userId ASC, tripId ASC`                    |
| `sync_events`         | 普通 | `tripId ASC`                                |
| `sync_events`         | 普通 | `createdAt ASC`                             |
| `audit_logs`          | 普通 | `tripId ASC`                                |
| `audit_logs`          | 普通 | `createdAt ASC`                             |
| `idempotency_records` | 普通 | `expiresAt ASC`                             |
| `rate_limit_records`  | 普通 | `expiresAt ASC`                             |
| `backup_manifests`    | 普通 | `createdAt DESC`                            |
| `backup_manifests`    | 普通 | `expiresAt ASC`                             |

<!-- cloud-indexes:end -->

## 云函数

1. 在根目录执行 `npm ci && npm run check && npm run build && npm run cloud:smoke-packages`；最后一项会在四个隔离临时目录中按真实上传清单执行生产依赖安装和根入口冷加载，完成后校验边界并自动清理。
2. `cloudbaserc.json` 是不含真实环境 ID 和运行模式变量的公开部署模板：四个函数锁定 `Nodejs20.19`、根入口 `index.main`、云端安装依赖及内存/超时；其中 `maintenance`、`backup` 均为 512MB/900 秒。部署前用下一节的命令从本机环境变量生成被 Git 忽略的 `cloudbaserc.private.json`。该私有配置会声明 `api` 的完整环境变量集合；CloudBase CLI 部署时会**完整覆盖而非合并**函数环境变量，所以生成器会拒绝未知变量、危险的内容安全组合、未经确认的协作模式和未经二次确认的生产部署。若改用微信开发者工具，必须在“更多设置”逐项配成相同值并在部署后核对函数信息。
3. 部署 `api`、`avatar-review`、`maintenance`、`backup`；每个函数必须上传根入口 `index.js`、`dist/index.js`、本目录 `package.json` 与独立 `package-lock.json`。不得删除 lockfile、上传 `src/` 替代构建产物或改用“更新到最新依赖”。
4. `api` 配置 `security.msgSecCheck`、`security.mediaCheckAsync`、`wxacode.getUnlimited` 权限。
5. 在“云开发—设置—其他设置—消息推送”新增事件类型 `wxa_media_check`，目标函数选择 `avatar-review`；部署后用真实头像验证回调日志与 `trace_id` 匹配。该函数拒绝小程序、开发者工具、HTTP 与云函数主动调用来源。
6. `maintenance` 每天北京时间 03:30 运行；`backup` 每天 04:30 运行。部署后确认 Cron 为七段格式、时区为 UTC+8，并验证实际 `SOURCE === 'wx_trigger'`。
7. 开发环境可设置 `CONTENT_SECURITY_MODE=disabled`；体验和生产必须删除该变量。
8. 根据发布门禁设置 `PRODUCT_MODE=solo` 或 `collaboration`；`MINIPROGRAM_ENV_VERSION` 与当前开发/体验/正式版一致。

PowerShell 私有配置与部署命令（尖括号内容只在本机填写，禁止提交）：

```powershell
$env:MINIPROGRAM_APP_ID='<private-real-appid>'
$env:CLOUDBASE_ENV_ID='<private-environment-id>'
$env:CLOUD_DEPLOYMENT_STAGE='development'
$env:PRODUCT_MODE='solo'
$env:MINIPROGRAM_ENV_VERSION='develop'
# 只有无真实用户数据的开发环境确有需要时才设置下一行；通常保持未设置：
# $env:CONTENT_SECURITY_MODE='disabled'
npm run cloud:config:prepare
npm run cloud:config:check

# 打开 cloudbaserc.private.json 人工确认目标后，才执行真实云端写操作：
$env:CONFIRM_CLOUD_DEPLOY='DEPLOY_REVIEWED_PRIVATE_CONFIG'
npm run cloud:deploy
```

`cloud:config:prepare` 会同时生成三类 Git 忽略文件：声明真实 AppID 和私有源码根的 `project.private.config.json`、显式绑定目标环境的 `miniprogram-private/` 小程序副本，以及包含完整四函数规格和运行变量的 `cloudbaserc.private.json`。公开 `miniprogram/config/cloud.ts` 始终保留空环境 ID 并失败关闭，不能直接作为真实项目上传。

`cloud:deploy` 会先要求工作区干净并重新执行依赖安装、完整检查、构建、四部署包演练、critical 审计和差异检查，然后才用固定 CloudBase CLI 3.6.3 部署。部署后它会解析 JSON 差异并要求四个函数全部为 `unchanged`；CloudBase CLI 仅退出 0 不算配置一致。首次部署时非 `api` 函数自然没有运行变量；若已有函数残留未知变量，CLI 的空对象不会主动清除它们，差异检查会失败，必须在云控制台人工清除并重新核验，不能静默保留。该结果仍不等同于真实烟测通过。部署结束后删除私有配置并关闭当前终端，或至少执行：

```powershell
Remove-Item -LiteralPath cloudbaserc.private.json
Remove-Item -LiteralPath miniprogram-private -Recurse
Remove-Item -LiteralPath project.private.config.json
Remove-Item Env:MINIPROGRAM_APP_ID
Remove-Item Env:CLOUDBASE_ENV_ID
Remove-Item Env:CLOUD_DEPLOYMENT_STAGE
Remove-Item Env:PRODUCT_MODE
Remove-Item Env:MINIPROGRAM_ENV_VERSION
Remove-Item Env:CONTENT_SECURITY_MODE -ErrorAction SilentlyContinue
Remove-Item Env:CONFIRM_CLOUD_DEPLOY
```

若 `project.private.config.json` 中还有需要保留的开发者工具本地设置，不要在工作期间清理它；生成器会保留其他字段并只更新 `appid`、`miniprogramRoot` 和 `srcMiniprogramRoot`。上面的删除步骤适用于部署/验收批次结束且不再需要该本机项目配置时。

协作模式还必须在生成和部署两个阶段设置 `ALLOW_COLLABORATION_DEPLOY=I_HAVE_PLATFORM_APPROVAL`；生产环境还必须设置 `ALLOW_PRODUCTION_DEPLOY=PRODUCTION_ENV_REVIEWED`。这些确认值不是平台许可的替代品，只用于防止误操作。官方能力依据：[CloudBase CLI 云函数配置](https://docs.cloudbase.net/cli-v1/functions/configs)、[云函数运行时](https://docs.cloudbase.net/cloud-function/runtime-support)和[基础配置](https://docs.cloudbase.net/cloud-function/function-configuration/config)。

## 云存储

- 使用下列自定义规则，客户端对整个云存储读写全禁。云函数管理端不受客户端规则限制，可生成/暂存头像、生成个人码、备份和执行清理；授权 API 只返回短期 HTTPS 展示地址，不返回原始云文件 ID。

```json
{
  "read": false,
  "write": false
}
```

- `avatars/<内部用户ID>/`：API 通过官方 `wx.cloud.CDN` 接收小程序本地临时文件，重新校验 SHA-256、大小、格式与账号路径，内容审核明确通过前不启用；未采用、拒绝、超时和注销文件均进入可靠清理。
- `profile-codes/<内部用户ID>/<随机场景令牌>.png`：云函数生成的小程序码；每次生成使用独立路径，冲突请求只清理自己的文件，注销时删除；页面只接收短期 HTTPS 地址。
- `private-backups/`：只允许备份/恢复云函数与管理员访问，客户端完全不可访问。

部署后分别用客户端和云函数测试允许/拒绝矩阵，不能只凭规则保存成功判断生效。

## 部署后烟测

- 首次微信身份登录、资料保存和内容安全拒绝样例。
- 验证客户端无法直接下载、上传或删除 `avatars/`、`profile-codes/` 和 `private-backups/`；基础库 2.12.0+ 的 CDN 暂存、1 MB/JPG/PNG 拒绝、断网同图片重试与 35 分钟孤儿清理均通过。
- 在 99 条首页行程时并发创建两条，确认仅一条成功、计数与首页均严格为 100；再覆盖邀请加入、归档、恢复、重开和退出的计数守恒。
- 创建行程、日期增删、账单跨日期移动、有效/无效账单、分账复制、完结、归档、恢复、退出登录和离线只读缓存。
- 协作版再测搜索、申请、拉黑、邀请、三账号实时同步与二维码。
- 临时阻断一次 `audit_logs` 或 `sync_events` 写入，确认行程 outbox 保留；恢复权限后触发 `maintenance`，确认投影被补齐、outbox 清空且无重复记录。
- 用专用测试账号把状态置于注销中断后的 `deleting`，手动触发 `maintenance`，确认共享账务金额不变、姓名快照匿名化、社交入口清除、旧 `OpenID` 解绑且再次触发幂等。
- 用官方定时触发器重复投递同一北京时间自然日的备份，确认只有一个 `bak_YYYYMMDD`、完成态复用且没有重复分页；再制造一次中途失败和一次过期租约，确认旧尝试文件清理后当天可安全重试。核对结构化摘要、manifest 和权限拒绝。
