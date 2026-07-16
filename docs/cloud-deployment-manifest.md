# 云开发部署清单

这是部署操作清单，不包含真实 AppID、环境 ID、密钥或用户数据。

## 集合与客户端权限

除 `sync_events` 外，下列集合全部设置为客户端不可读、不可写：

`users`、`trips`、`friend_requests`、`friendships`、`blocks`、`notifications`、`trip_invitations`、`audit_logs`、`idempotency_records`、`rate_limit_records`、`backup_manifests`。

`sync_events` 使用：

```json
{
  "read": "auth.openid == doc.ownerOpenId",
  "write": false
}
```

## 索引

在开发环境先创建并用实际查询验证，确认后逐项复制到生产环境：

| 集合                  | 类型      | 字段顺序                                    |
| --------------------- | --------- | ------------------------------------------- |
| `users`               | 唯一      | `openId ASC`                                |
| `users`               | 唯一      | `publicId ASC`                              |
| `users`               | 唯一/稀疏 | `qrSceneToken ASC`                          |
| `trips`               | 普通      | `memberIds ASC`                             |
| `trips`               | 普通      | `_id ASC, version ASC`                      |
| `friend_requests`     | 普通      | `fromUserId ASC, toUserId ASC, status ASC`  |
| `friend_requests`     | 普通      | `toUserId ASC, createdAt DESC`              |
| `friendships`         | 普通      | `userIds ASC`                               |
| `blocks`              | 普通      | `blockerUserId ASC, blockedUserId ASC`      |
| `notifications`       | 普通      | `userId ASC, createdAt DESC`                |
| `notifications`       | 普通      | `tripId ASC`                                |
| `trip_invitations`    | 普通      | `tripId ASC, inviteeUserId ASC, status ASC` |
| `sync_events`         | 普通      | `userId ASC, tripId ASC, createdAt DESC`    |
| `audit_logs`          | 普通      | `tripId ASC, createdAt DESC`                |
| `idempotency_records` | 普通      | `expiresAt ASC`                             |
| `rate_limit_records`  | 普通      | `ownerHash ASC, scope ASC, bucket ASC`      |
| `rate_limit_records`  | 普通      | `expiresAt ASC`                             |
| `backup_manifests`    | 普通      | `createdAt DESC`                            |

## 云函数

1. 在根目录执行 `npm ci && npm run check && npm run build`。
2. 部署 `api`、`maintenance`、`backup`，选择云端安装依赖。
3. `api` 配置 `security.msgSecCheck`、`security.imgSecCheck`、`wxacode.getUnlimited` 权限。
4. `maintenance` 每天北京时间 03:30 运行；`backup` 每天 04:30 运行。
5. 开发环境可设置 `CONTENT_SECURITY_MODE=disabled`；体验和生产必须删除该变量。
6. 根据发布门禁设置 `PRODUCT_MODE=solo` 或 `collaboration`；`MINIPROGRAM_ENV_VERSION` 与当前开发/体验/正式版一致。

## 云存储

- `avatars/`：用户头像，允许本人通过小程序上传，读取仅限业务所需；注销时删除。
- `profile-codes/`：云函数生成的小程序码；注销时删除。
- `private-backups/`：只允许备份/恢复云函数与管理员访问，客户端完全不可访问。

## 部署后烟测

- 首次微信身份登录、资料保存和内容安全拒绝样例。
- 创建行程、日期增删、账单跨日期移动、有效/无效账单、分账复制、完结、归档、恢复、退出登录和离线只读缓存。
- 协作版再测搜索、申请、拉黑、邀请、三账号实时同步与二维码。
- 临时阻断一次 `audit_logs` 或 `sync_events` 写入，确认行程 outbox 保留；恢复权限后触发 `maintenance`，确认投影被补齐、outbox 清空且无重复记录。
- 手动触发维护和备份，核对结构化摘要、manifest 和权限拒绝。
