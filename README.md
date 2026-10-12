# Telegram WEB 代理个人修正版

基于 [ToiCF/CF-Workers-TGProxy](https://github.com/ToiCF/CF-Workers-TGProxy) 的 Cloudflare Workers Telegram WEB 代理，当前版本 **1.0.1**。通过 SQLite Durable Object 管理会话，包含会话续期、主动撤销、缓冲上限和 Apple WebKit `Origin: null` 兼容修复。

这是 Telegram 客户端中的 **WEB** 代理，需在客户端代理设置中选择 WEB 类型。链路为 Telegram 内置 WebView → Cloudflare Worker → Telegram 官方 KWS WebSocket 入口；普通 SOCKS5 和 MTProto 配置不能直接使用这份实现。

## 操作指南

- [完整部署与更新指南](docs/deployment.md)：Wrangler 部署、密钥设置、自有域名绑定、Telegram 配置、额度和默认限制。
- [连接故障排查](docs/troubleshooting.md)：健康检查、完整链路诊断、Cloudflare 日志、iPhone / macOS 连接失败的原因。
- [上游原版代码审查](docs/upstream-audit.md)：修复前的问题、复现证据和个人使用影响。
- [变更记录](CHANGELOG.md)：个人修正版的修复内容。
- [验证记录](docs/validation.md)：测试结果及验证范围。

## 快速部署

准备 Node.js 22 或更新版本，以及 Cloudflare 账号。先用 GitHub 账号克隆项目：

```bash
git clone https://github.com/ricardo-le/cf-workers-tgproxy-personal.git
cd cf-workers-tgproxy-personal
```

然后执行：

```bash
npm ci
npx wrangler login
npm run deploy
```

第一次部署会建立 `SESSIONS` Durable Object 绑定和 SQLite 迁移。随后生成两份独立随机值：

```bash
openssl rand -hex 16
openssl rand -hex 24
```

第一份是客户端访问密钥 `SECRET`，第二份是服务端签名密钥 `BOOT`。分别通过交互输入写入 Worker：

```bash
npx wrangler secret put SECRET
npx wrangler secret put BOOT
```

这两个值仅写入 Cloudflare，不要加入代码或提交到 Git。测试文件中的固定密钥属于公开测试向量，不能用于部署。尚未设置密钥时，`/health` 返回 500 是预期表现。

在 Worker 的 Settings → Domains & Routes 中添加 Custom Domain，或使用部署输出的 workers.dev 地址。检查：

```bash
curl https://tgproxy.example.com/health
```

`tgproxy.example.com` 是占位域名，应换成实际 Worker 主机名。正常返回：

```json
{"ok":true,"variant":"personal-fixed"}
```

Telegram 中新增 WEB 代理：服务器只填写实际主机名，密钥填写 `SECRET`。WEB 使用 HTTPS / 443；`BOOT` 不交给客户端。完整部署配置必须包含 Durable Object，单独粘贴 JS 不能完成本版部署。

## 完整链路诊断

```bash
npm run diagnose -- tgproxy.example.com
```

脚本会在本机要求输入 `SECRET`，输入不回显。它依次验证健康检查、桥页面签名、会话、WebSocket 和 Telegram DC 2 的真实协议响应，然后删除诊断会话。脚本不会登录 Telegram 账号，也不能替代 Telegram 内置 WebView 与全部功能的测试。

## 本地检查

```bash
npm test
npm run build
```

`npm run build` 只执行 Wrangler dry-run，不部署到 Cloudflare。更新已部署的 Worker 时，替换源码后运行 `npm run deploy`；保留原有密钥、`SESSIONS` 绑定和迁移记录。此前版本已经支持这些绑定，升级 1.0.1 无需重建命名空间。

## 目录

```text
telegram_webproxy.js            Worker 源码与 ProxyCoordinator
wrangler.jsonc                 部署配置与 SQLite 迁移
scripts/diagnose-tgproxy.mjs    实际链路诊断
tests/regression.cjs           协议、会话和资源控制回归测试
tests/runtime.mjs              workerd / SQLite Durable Object 集成测试
docs/                          部署、排障、审查和验证说明
CHANGELOG.md                   版本变更
LICENSE                        GPL-3.0 许可证
SHA256SUMS.json                项目文件校验值
```

本版用于个人、小规模使用。普通 WebSocket 持续连接会消耗 Durable Object 运行时额度，请查看 [Cloudflare Durable Objects 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)和账号实际用量。修复目标是稳定性，实际线路速度和完整 Telegram 功能需自行验证。

## 来源与许可证

上游基线为提交 [`9089a0496219ccbcfcaea261a98dd2a644b3757f`](https://github.com/ToiCF/CF-Workers-TGProxy/tree/9089a0496219ccbcfcaea261a98dd2a644b3757f)。本仓库保留 GPL-3.0 许可证和源码来源说明，个人修订日期为 2026-10-11。
