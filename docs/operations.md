# 监控、告警与故障处理

## 监控目标

- `api`：调用量、P50/P95 时延、错误率、`INTERNAL_ERROR`、`REQUEST_RESULT_UNCERTAIN`、内容审核不可用和限流次数。
- 协作：`trip-change-publish-failed`、`notification-publish-failed`、同步信号到客户端刷新延迟。
- 头像审核：`avatar-review-applied` 的通过/拒绝数量、`CONTENT_CHECK_UNAVAILABLE`、35 分钟超时数和回调更新连续冲突；不得记录头像 URL 或 `trace_id`。
- 维护：每日 `maintenance-complete` 是否出现、`projectionsRepaired`、`projectionFailures`、`accountDeletionsCompleted`、`accountDeletionConflicts`、`accountDeletionTripsUpdated`、`expiredAvatarReviewsRemoved`、`oldAuditLogsRemoved`、冲突跳过数、清理数和执行时长。
- 备份：每日 `backup-complete`、manifest 状态、集合页/文档数突变、连续失败和存储用量。
- 资源：数据库读写量、云函数 GBs、云存储容量/流量、费用与预算余额。

## 建议告警

- 5 分钟窗口 `api` 错误率 > 2%，或任一分钟 `INTERNAL_ERROR >= 5`。
- 任意 `REQUEST_RESULT_UNCERTAIN`、头像回调连续冲突、备份失败、维护连续两天未成功。
- 同步或通知投影失败 > 0 时触发开发告警，并运行修复/核对流程。
- 月预算达到 50%/80%/100%，存储量日增幅 > 20%。
- 云函数 P95 > 2 秒持续 15 分钟；20 人/100 账单结算超过 2 秒。

## 日志要求

- 只记录 action、requestId、内部实体 ID、错误码、版本和计数。
- 禁止记录 `OpenID`、用户名、签名、账单事件、头像 URL、金额明细、完整请求/响应。
- 高风险审计保留 180 天；普通函数日志按平台和成本策略缩短保留。

## 故障响应

1. 判断是前端、云函数、数据库、内容安全还是微信平台故障。
2. 写入不确定时优先只读拉取权威数据，不诱导用户重复提交。
3. 必要时关闭协作开关或上传只读维护版，保存错误摘要和时间线。
4. 修复后在开发/体验环境回放最小复现，完成自动化和三账号回归再恢复正式版。
5. 记录影响用户数、数据一致性结果、根因、修复和预防项；涉及个人信息时按适用规则评估通知义务。
