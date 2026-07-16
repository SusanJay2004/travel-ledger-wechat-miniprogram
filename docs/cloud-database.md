# 云数据库模型与权限

## 权限原则

- `users`、`trips` 及后续协作集合全部禁止小程序客户端直接读写。
- 用户身份只能由云函数中的微信 `OPENID` 建立，客户端传入的用户 ID 不能作为鉴权依据。
- 所有写命令校验成员身份、资源状态和 `expectedVersion`；版本不一致返回 `VERSION_CONFLICT`。
- 金额只保存整数分，日期只保存 `YYYY-MM-DD` 字符串，事件时间保存 ISO 8601 UTC 字符串。

## `users`

- `_id` / `id`：内部稳定 ID。
- `openId`：微信环境内用户身份，只允许云端读取。
- `publicId`：10 位公开搜索 ID。
- `displayName`、`signature`、`avatarUrl`：用户资料。
- `qrCodeFileId`：协作版按公开 ID 生成并缓存的个人小程序码文件 ID；场景参数不包含 `OpenID`。
- `status`、`createdAt`、`updatedAt`：生命周期字段。

唯一索引：`openId`、`publicId`。

## `trips`

- `_id` / `id`、`name`、`status`。
- `memberIds`：用于成员过滤的内部 ID 数组。
- `members`：成员显示名快照和每用户 `home|archived|detached` 状态。
- `dates`：有序日历日期。
- `bills`：账单、参与份额、付款明细、校验码和软删除字段。
- `totalCents`、`invalidBillCount`：列表派生摘要。
- `version`：所有写入的乐观并发版本。
- `ledgerRevision`：影响分账结果的账本版本。
- 操作者、创建/修改/完结时间字段。

普通索引：`memberIds`、`version`。

## 协作集合

协作模式还使用以下禁止客户端直接读写的集合：

- `friend_requests`：好友申请及 30 天有效期。
- `friendships`：排序后的双用户 ID 数组。
- `blocks`：单向拉黑关系。
- `notifications`：用户自己的应用内通知。
- `trip_invitations`：行程邀请及 7 天有效期。
- `sync_events`：每个成员自己的实时同步信号，携带由云端写入的 `ownerOpenId`。
- `audit_logs`：行程变更操作审计，仅云端可读写。
- `idempotency_records`：写命令的请求去重、完成或失败结果，保留 24 小时。

需要为各集合的用户 ID、状态和到期时间组合建立查询索引。生产云函数默认 `solo`；只有平台发布门禁通过后才设置环境变量 `PRODUCT_MODE=collaboration`。

`sync_events` 是唯一需要客户端读取的协作集合，安全规则必须同时满足：

```json
{
  "read": "auth.openid == doc.ownerOpenId",
  "write": false
}
```

客户端监听时必须带 `userId + tripId` 精确条件；其他协作集合继续保持客户端不可读写。

所有写命令都必须携带 8–80 位 `requestId`。云端以 `SHA-256(OpenID + requestId)`
作为幂等记录主键；同一请求的网络重试复用原标识并返回首次结果。若业务可能已提交但结果记录写入失败，
记录保持 `processing`，服务端拒绝重放并要求客户端刷新权威数据，不能删除标记后重复执行。

审计和同步投影使用“行程 ID + 版本 + 动作 + 用户”的确定性文档 ID，重复发布不会生成重复记录。
投影失败记录结构化错误但不把已经提交的账本写入伪装成失败；进入多人灰度前还需部署投影修复任务并演练故障恢复。

归档是每位成员独立的视图状态；30 天到期后服务端拒绝恢复并不再返回到期记录。用户主动清空时仅将自己的
`viewState` 改为 `detached`，不会删除其他成员仍保留的共享行程。定时清理任务负责删除所有成员都已脱离的孤儿数据。

## 生产前迁移方向

当前单人 MVP 将最多 100 条账单内嵌在行程文档中，以便事务式原型开发。进入多人灰度前必须执行容量压测；若接近云数据库单文档限制，则将账单迁移至独立 `bills` 集合，并保留 `Trip` 摘要与版本字段。迁移必须提供双读校验、备份和回滚脚本，不能直接修改生产数据。
