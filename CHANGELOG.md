# 变更记录

## 1.0.1 — 2026-10-11

- 修复 Apple WKWebView 在 CSP sandbox 下发送 `Origin: null` 时，被 Worker 和会话协调器拒绝的问题。
- 保留 bridge / bootstrap / session / lane 认证、CSP 和其他网站 Origin 的拒绝行为。
- 增加真实 workerd / SQLite 的 opaque-origin 创建、续期、WebSocket 和删除验证。
- 整理中文部署与排障文档，纳入实际 DC 2 链路诊断脚本；诊断 CLI 要求显式传入 Worker 主机名。

## 1.0.0 — 2026-10-11

- 用 SQLite Durable Object 统一协调每个域名和 SECRET 对应的会话，替代不可靠的 isolate 内局部会话控制。
- 增加活动会话续期和空闲过期，避免固定五分钟令牌导致新 lane 失败。
- bootstrap 创建采用幂等消费，关闭后不能使用同一 bootstrap 重新激活会话。
- DELETE 主动关闭已有 lane；撤销标记和已使用 SID 持久化。
- 增加会话 / lane 额度和服务端缓冲字节 / 条目上限，覆盖排队、处理中和部分加密临时数据的记账。
- 隔离慢 POST 请求，避免阻塞其他控制请求；保护第 33 条 lane 失败时的现有连接。
- 约束 SECRET 为 32 位 hex 或 `dd` 加 32 位 hex，补齐 Wrangler 绑定、SQLite 迁移、依赖清单和回归测试。

上游基线：ToiCF/CF-Workers-TGProxy 提交 `9089a0496219ccbcfcaea261a98dd2a644b3757f`，GPL-3.0。
