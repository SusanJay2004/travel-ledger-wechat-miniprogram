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

需要为各集合的用户 ID、状态和到期时间组合建立查询索引。生产云函数默认 `solo`；只有平台发布门禁通过后才设置环境变量 `PRODUCT_MODE=collaboration`。

## 生产前迁移方向

当前单人 MVP 将最多 100 条账单内嵌在行程文档中，以便事务式原型开发。进入多人灰度前必须执行容量压测；若接近云数据库单文档限制，则将账单迁移至独立 `bills` 集合，并保留 `Trip` 摘要与版本字段。迁移必须提供双读校验、备份和回滚脚本，不能直接修改生产数据。
