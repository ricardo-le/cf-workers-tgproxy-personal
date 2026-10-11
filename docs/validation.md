# 验证记录

整理日期：2026-10-11。Worker 版本：1.0.1。

## 本次项目整理的检查

本机使用 Node.js 22.23.2、Wrangler 4.149.0，执行：

```bash
npm ci
node --check telegram_webproxy.js
node --check scripts/diagnose-tgproxy.mjs
npm test
WRANGLER_SEND_METRICS=false npm run build
```

结果：

- 依赖安装成功，npm 报告 0 个已知漏洞。
- 两个 JS 入口语法检查通过。
- 21 项回归测试通过，失败数为 0。
- 2 项真实 workerd / SQLite Durable Object 集成测试通过，失败数为 0。
- Wrangler dry-run 退出码为 0，识别 `SESSIONS (ProxyCoordinator)` 绑定。
- 诊断 CLI 未传域名时输出用法并退出；失败诊断没有回显输入的测试密钥。
- Worker 源文件与此前交付的 1.0.1 完全一致，SHA-256 为 `b269bbf3277a17f5eec7dc49a9ea42741c671a477c617e44b8d766837a0b372d`。
- 提交文件经过凭证与内容检查，使用占位域名，不含实际部署密钥、本地环境文件、私钥、依赖目录或运行缓存。

这些检查没有部署到 Cloudflare，也没有修改已有 Worker 或 DNS。dry-run 关闭了 Wrangler 遥测，以避免打包完成后等待遥测请求。

## 测试覆盖

回归测试覆盖官方 bridge HMAC 向量、24 组分片 AES-CTR、bootstrap 幂等创建、原始 BOOT 拒绝、密钥格式、续期、DELETE 主动关闭、跨 Worker 上下文 SID 唯一性、协调对象重建后的撤销、会话额度、慢 POST、缓冲与加密记账、第 33 条 lane 的保护，以及三种传输模式的双向字节转换。

集成测试使用真正的 workerd 和 SQLite Durable Object，验证桥页面、会话创建、并发重试、真实 Worker WebSocket 升级、续期和 DELETE，以及 `Origin: null` 下的认证生命周期和其他网站来源的拒绝。测试环境没有登录 Telegram 账号，不代表全部线上 Telegram 功能已验证。

## 此前排障证据

用户在实际已部署 Worker 上运行诊断脚本，五个阶段通过，包括 Telegram DC 2 的真实 resPQ 和 nonce 校验；该结果属于当时的链路验证，不是本次重新测量。

此前另外用真实 macOS WKWebView 复现 Apple Origin 问题：旧校验下 session 返回 404，1.0.1 校验下收到 WELCOME。该探针隔离了 WebKit / Worker 认证入口，其后端响应使用测试夹具；实际 SQLite 会话由上述 workerd 集成测试另外验证。探针中的临时 HTTPS 证书、私钥和本机环境不纳入仓库。

仍应在自己的部署上验证长时间使用、登录后的操作、文件下载、全部 DC、iPhone 实际网络和后台行为、Telegram 通话与网络切换。任何测试结果都不保证线路速度。
