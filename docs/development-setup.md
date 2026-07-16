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
6. 在云开发数据库创建 `users` 和 `trips` 集合，客户端权限均设为“所有用户不可读写”。所有业务读写只经 `api` 云函数。
7. 为集合建立索引：
   - `users.openId`：唯一索引。
   - `users.publicId`：唯一索引。
   - `trips.memberIds`：普通索引。
   - `trips.version`：普通索引，用于乐观并发更新。
8. 执行 `npm install`、`npm run check` 和 `npm run build`。
9. 在开发者工具中上传并部署 `cloudfunctions/api`，选择“云端安装依赖”。

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
