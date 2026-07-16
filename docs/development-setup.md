# 开发环境设置

## 已安装工具

- Node.js 22 或更高版本
- npm 11
- Git
- GitHub CLI
- 微信开发者工具

## 首次配置（需要小程序管理员本人操作）

1. 在微信公众平台注册个人小程序，取得开发用 AppID。
2. 打开微信开发者工具并扫码登录，导入本仓库根目录。
3. 将开发者工具生成的 `project.private.config.json` 保留在本机；不要提交。
4. 在项目设置中填写真实 AppID。仓库中的 `project.config.json` 使用游客 AppID，防止公开真实配置。
5. 开通云开发，创建一个开发环境。生产发布时另建生产环境。
6. 按 [cloud-database.md](./cloud-database.md) 创建完整集合、索引和安全规则。除 `sync_events` 的用户自有读取规则外，客户端均不可直接读写权威集合。
7. 为集合建立索引：
   - `users.openId`：唯一索引。
   - `users.publicId`：唯一索引。
   - `users.qrSceneToken`：唯一稀疏索引。
   - `users._id + version`：普通组合索引，用于资料和注销的乐观并发更新。
   - `users.status`：普通索引，用于维护任务重试已注销账号的云文件清理。
   - `trips.memberIds`：普通索引。
   - `trips.version`：普通索引，用于乐观并发更新。
8. 执行 `npm install`、`npm run check` 和 `npm run build`。
9. 在开发者工具中上传并部署 `cloudfunctions/api`，选择“云端安装依赖”。

当前项目尚无生产数据，用户的 `homeTripCount` 在首次登录时从 0 初始化。若未来从旧版本升级，部署事务容量版本前必须暂停写入，按每个用户 `viewState=home` 的行程数回填并抽样核对，不能直接以 0 覆盖。

## 云函数环境变量

- `PRODUCT_MODE=solo|collaboration`：默认 `solo`，只有协作发布门禁通过后才可启用完整社交功能。
- `MINIPROGRAM_ENV_VERSION=develop|trial|release`：控制个人小程序码落到开发版、体验版或正式版。
- `CONTENT_SECURITY_MODE=disabled`：只允许本地、无真实用户数据的开发环境临时设置。体验与生产环境必须删除该变量，让文本和头像审核失败关闭。

云函数需要在微信公众平台和云开发中具备内容安全接口、小程序码、云存储读写与删除所需权限。发布前必须用真实开发 AppID 验证这些接口；游客 AppID 无法完成该验证。

## 常用命令

```powershell
npm install
npm run check
npm run build
```

## 本机私有文件

以下文件已被 `.gitignore` 排除：

- `project.private.config.json`
- `.env*`
- 上传私钥
- 云环境私有配置
- 真实用户数据和日志

## GitHub 登录与推送

GitHub CLI 安装后需要用户本人执行一次：

```powershell
gh auth login --web
```

完成授权后，可在仓库根目录创建公开仓库并推送：

```powershell
gh repo create travel-ledger-wechat --public --source . --remote origin --push
```
