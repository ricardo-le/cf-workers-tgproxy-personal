# 连接故障排查

## 健康检查通过为什么还会一直“连接中”

```bash
curl https://tgproxy.example.com/health
```

返回 `{"ok":true,"variant":"personal-fixed"}` 只说明 Worker 路由能运行，密钥格式和 Durable Object 绑定通过基本校验。它没有创建 Telegram 会话，没有升级 WebSocket，也没有联系 Telegram DC，因此不能单凭 HTTP 200 判断 Telegram 已能使用。

先确认客户端代理类型是 WEB，服务器字段仅有主机名，SECRET 与 Worker 中的值一致。当前安装包必须提供 WEB 类型；即使某个平台的源代码支持，也不能推断所有旧版本和第三方客户端都支持。

## 检查完整链路

在仓库目录执行：

```bash
npm run diagnose -- tgproxy.example.com
```

将示例域名换成实际 Worker 主机名；不要添加 `https://` 或路径。脚本使用 Node.js 22+ 内置的 fetch 和 WebSocket，在本机交互输入 SECRET，不把它放进命令参数。

成功结果会依次包含：

1. 健康检查：HTTP 200。
2. 桥页面与 SECRET 签名：取得签名 bootstrap。
3. Durable Object 会话：POST 200、响应头和 WELCOME 帧正确。
4. Worker WebSocket：升级成功、子协议正确。
5. Telegram 上游协议响应：收到 DC 2 的有效 resPQ，随机 nonce 校验通过。

诊断结束会尝试删除会话；如清理失败，脚本会提示。使用同一域名下的诊断会话会占用个人代理的会话额度；诊断不登录账号，也不访问消息。

这些阶段全部通过，说明运行诊断的电脑到 Worker、会话、WebSocket 和 DC 2 的链路通过。它未模拟 Telegram 的内置 WebView，也未验证其他 DC、全部功能、手机当前网络或长时间后台连接。

## 查看 Cloudflare 请求日志

在项目目录执行：

```bash
npx wrangler tail
```

关闭 Telegram 的 WEB 代理，再重新开启。观察桥页面 GET、`POST /api/v1/session` 和 `GET /api/v1/ws`，检查是否有异常。

tail 中的 `Ok` 表示这次 Worker 执行没有未捕获异常，不等于 HTTP 状态是 200。代码返回 404 等受控错误时，也可能显示 `Ok`。如果桥页面和 session POST 不断重复、始终没有 WebSocket 请求，要继续排查会话请求和客户端桥接行为。

分享日志前隐藏 `?bridge=` 后的值、Authorization、Sec-WebSocket-Protocol、bootstrap、会话令牌及真实 SECRET / BOOT。仓库默认关闭 observability，诊断时也不应新增打印凭证的代码。

## iPhone / macOS：remote-close 与 WebKit Origin

在此前部署中，iPhone 和 macOS App Store Telegram 12.10.282987 都持续显示“连接中”。完整 Node.js 链路诊断已经通过，但 macOS 客户端日志反复显示：

```text
bridge response accepted
page initialization accepted
hello sent
page status: failed
carrier failure: remote-close
```

`remote-close` 本身不是某一个故障的唯一证据。此次用真实 macOS WKWebView 复现后发现，页面的 CSP sandbox 会使 WebKit 会话请求携带字面值 `Origin: null`，即使 sandbox 包含 `allow-same-origin`。旧校验拒绝该 Origin，Worker 或 Durable Object 返回 404；桥页面因此报告失败，客户端反复重建连接。

1.0.1 在两个校验入口允许缺失 Origin、同源 Origin 和字面值 `null`，随后仍验证 bridge、bootstrap、会话签名和 lane 凭证。任意其他网站来源仍然被拒绝，CSP 保留，没有添加宽泛 CORS 放行。

真实 WKWebView 测试中，修复前返回 404，修复后收到 WELCOME。集成测试另外验证了实际 workerd / SQLite 会话生命周期。上述测试支持这个兼容修复，不等于已登录真实 iPhone 账号验证全部 Telegram 功能。

macOS 原生 Telegram 可尝试查看对应桥接日志：

```bash
log stream --level info --style compact \
  --predicate 'subsystem == "org.telegram.WebProxyTransport"'
```

再关闭并重新开启 WEB 代理。如果客户端没有这个日志子系统，或版本更改了日志实现，命令可能没有输出。

## 更新、配额与网络切换

- 从个人修正版 1.0.0 升级：替换 `telegram_webproxy.js` 后运行 `npm run deploy`，保留密钥、绑定及迁移。关闭再开启客户端代理，使其加载新的桥页面。
- `/health` 返回 500：检查 SECRET、BOOT 和 `SESSIONS`；SECRET 推荐独立生成的 32 位 hex，BOOT 推荐 48 位随机 hex。
- session 返回 503：检查会话额度和 Cloudflare 平台额度。本版每个域名最多 4 个客户端会话，诊断也会占用一个；正常关闭旧代理可释放会话，遗留无活动会话最多 30 分钟后失效。
- 直接打开根页面空白：这是预设行为，页面不是登录界面；完整桥页面需要客户端生成的有效签名。
- 长连接仍可能因平台重启、WebView 被系统关闭、网络中断或 Wi-Fi / 蜂窝切换而重建。部署后应测试连续使用超过 30 分钟、文件下载和网络切换。

完整配置与默认限制见 [部署指南](deployment.md)。
