# Telegram WEB 代理个人修正版

当前版本：**1.0.1，包含 Apple WebKit Origin 兼容修复**。如果已经按上一版部署，替换项目里的 `telegram_webproxy.js` 后执行 `npx wrangler deploy` 即可；现有绑定、迁移、域名、SECRET 和 BOOT 均可继续使用。

此前 `/health` 和 Node.js 诊断都可能通过，而 iPhone 或 macOS 原生 Telegram 的 WEB 代理仍停在“连接中”。真实 WKWebView 测试发现，响应 CSP 中的 sandbox 会让 WebKit 的会话请求携带 `Origin: null`，旧代码会在 Worker 或 Durable Object 的 Origin 校验处返回 404。桥页面因此报告 `failed`，客户端记录 `carrier failure: remote-close`。

1.0.1 允许缺失 Origin、同源 Origin 和 WebKit 的字面值 `null`，随后仍严格验证 bootstrap、会话签名、lane 凭证及状态；其他网站的 Origin 继续被拒绝。保留原有 CSP，不增加 CORS 放行。测试覆盖了空来源下的创建、续期、WebSocket 升级、删除和拒绝无效凭证，并用真实 macOS WebKit 复现修复前后的 WELCOME 握手。

基于 [ToiCF/CF-Workers-TGProxy](https://github.com/ToiCF/CF-Workers-TGProxy) 提交 `9089a0496219` 修改，遵循 GPL-3.0，保留原项目 LICENSE。修改日期：2026-10-11。

## 个人使用时，原版问题有多大

直接影响日常使用的是：原版令牌五分钟后无法创建新流，可能导致重连；慢速下载时接收缓冲不受控。跨实例状态和 bootstrap 重放通常在多人使用、频繁重建或密钥被分享后更明显，但个人使用也不能保证 DELETE 和 SID 限制可靠。

本版保留原始 KWS/MTProto 传输转换，通过一个 SQLite Durable Object 统一管理每个域名下的个人会话，并修复令牌续期、主动删除、bootstrap 幂等创建、缓冲记账及密钥格式。目标是改善稳定性，未承诺提高速度。

## 文件

- `telegram_webproxy.js`：完整 Worker 模块，同时导出 `ProxyCoordinator` Durable Object。
- `wrangler.jsonc`：部署配置，包含 `SESSIONS` 绑定与 SQLite 迁移。
- `package.json`、`package-lock.json`：部署和测试工具的版本配置。
- `tests/`：本地回归与 Cloudflare workerd 集成测试。
- `LICENSE`：原项目 GPL-3.0 许可证。

**这版不能只粘贴 JS 到面板就完成部署。必须配置 Durable Object 绑定和迁移，建议直接按下方 Wrangler 步骤部署完整文件夹。**

## 部署步骤

准备 Node.js 22 或更新版本、Cloudflare 账号，以及支持 WEB 类型的 Telegram 客户端。

1. 克隆本仓库后进入项目根目录；也可以下载完整 ZIP 并解压后进入包含 `wrangler.jsonc` 的目录。执行：

   ```bash
   npm ci
   npx wrangler login
   npx wrangler deploy
   ```

   默认会创建名为 `cf-tgproxy-personal` 的 Worker，并自动创建 SQLite Durable Object 命名空间。第一次部署完成后，因为尚未配置密钥，`/health` 返回 500 是预期表现。

   如需不同 Worker 名称，可以在部署前修改 `wrangler.jsonc` 的 `name`。建议先新建这个 Worker，验证能用后再替换旧代理。不要改动绑定名称 `SESSIONS`、类名 `ProxyCoordinator` 或迁移中的 `new_sqlite_classes`。

2. 在本机生成两份独立随机值：

   ```bash
   openssl rand -hex 16
   openssl rand -hex 24
   ```

   第一份是 32 位十六进制的 SECRET；第二份是 48 位十六进制的 BOOT。妥善保存，不要用文档或测试里的示例密钥。

3. 在刚才的项目目录执行：

   ```bash
   npx wrangler secret put SECRET
   npx wrangler secret put BOOT
   ```

   每条命令会提示输入：分别粘贴对应值。SECRET 用于客户端访问，BOOT 是服务端令牌签名密钥，不需要交给 Telegram。配置过程中，Wrangler 会更新已部署 Worker。

4. 使用部署输出中的 HTTPS 地址检查：

   ```bash
   curl https://你的Worker域名/health
   ```

   正常应返回：

   ```json
   {"ok":true,"variant":"personal-fixed"}
   ```

   这验证了基本密钥和绑定配置，不代表已测试 Telegram KWS 上游连通性。

5. 在 Telegram 设置里新增 **WEB** 代理，服务器填写 Worker 主机名，例如 `cf-tgproxy-personal.你的子域.workers.dev`，密钥填写 SECRET。WEB 固定使用 HTTPS/443，不填写账号密码、BOOT 或 `/api/v1/ws`。

   也可以由支持的客户端直接打开：

   ```text
   tg://webproxy?server=你的Worker域名&secret=你的SECRET
   ```

   链接中包含访问密钥，分享链接就等同于分享代理访问权限。

6. 如需自有域名，在 Worker 的 Settings → Domains & Routes 中添加 Custom Domain，然后把 Telegram 的服务器字段换成这个域名。域名必须实际绑定至 Worker，普通 DNS 指向或仅有 CNAME 不等于已经设置好 Worker 路由。更换域名会建立新的协调对象，会话额度按域名分别计算。

客户端必须显示 WEB 代理选项。已检查 Telegram Desktop v7.3.1 源码支持 WEB，Android 当前主线也支持；具体安装包以实际界面为准。此程序不能填进普通 SOCKS5／MTProxy 类型，Apple 桥接行为已用真实 macOS WKWebView 验证；完整 iPhone 登录、全部功能和 Telegram 通话代理仍需在实际客户端验证。

## 本版的行为和默认限制

- 每个域名最多 4 个尚未删除／过期的客户端会话，每会话最多 32 条 lane。
- 页面每五分钟自动续期。签名令牌有效期 30 分钟；有效会话有活动或成功续期时继续存活。活跃会话可在令牌过期后进行受控续期，不会单纯因固定令牌 TTL 被强制断开。
- 完全没有流量和续期的会话，30 分钟后失效；后台 WebView 被系统关闭、网络中断或平台重启后，客户端仍可能需要重连。
- 同一个 bootstrap 的重复创建返回同一会话，关闭后不能用它重新激活。
- DELETE 主动关闭该会话全部 lane；删除标记和已使用 SID 写入持久存储。
- 页面达到 32 lane 时，只向客户端返回超出流的 CLOSE，不会因这一限制关闭现有 32 条流。
- 未完成上游首次响应的 lane 最多等待 30 秒。
- 每 lane 上游接收的排队与处理中字节共用 8MiB 限额，条目上限 1024。各会话共享 32MiB 应用层缓冲预算，上传尾包、处理中的接收包和加密临时数据均纳入记账；超限关闭相应流，避免无限积累。
- 缓冲预算是代码控制的逻辑字节数，**不是整个进程内存的绝对上限**：Cloudflare 运行时的 WebSocket 内部缓冲、JS 对象开销和 GC 属于运行时管理。浏览器和原生客户端继续使用已有的流量窗口协议。
- 密钥支持纯 32 位 hex，或 `dd` 加 32 位 hex。建议首先使用纯 32 位 hex；不接受 README 原先列出的 `ee`／`ef` 17 字节格式。

这些参数集中在 JS 顶部 `CFG`。不建议一开始调高限额，先验证一个客户端和大文件下载。

## Cloudflare 额度

SQLite Durable Objects 可用于 Workers 免费计划。本版需要同时维持 Telegram 上游 WebSocket 和 AES-CTR 流状态，使用普通 WebSocket，不使用休眠 API；连接持续期间会消耗 Durable Object 运行时额度。免费计划超过配额会报错，付费计划可能产生额外费用。

多个域名会形成多个协调对象。请根据 Cloudflare 账号的实际使用量判断，不把这份代码理解为“无限免费代理”。定价与额度见 [Cloudflare 官方说明](https://developers.cloudflare.com/durable-objects/platform/pricing/)。

为避免连接 URL 和凭证被常规访问日志保存，配置关闭了 Worker observability；如自行启用详细日志，不要记录 bridge URL、Authorization 和 Sec-WebSocket-Protocol。

## 本地验证

```bash
npm test
npm run build
```

测试覆盖：官方 HMAC 向量、24 组随机分片 AES-CTR、bootstrap 并发与重试、原始 BOOT 拒绝、密钥格式、五分钟后的续期、过期活跃会话续期与空闲失效、主动删除、跨 Worker 实例 SID 唯一性、协调对象重建后的撤销、会话额度、慢 POST 不阻塞其他操作、队列超限／合包／关闭记账、生成的 Android 桥页面执行、32 lane 超限保护，以及三种传输模式的双向字节转换。

完整链路诊断与 Apple 客户端日志排查见 [故障排查](troubleshooting.md)。

集成测试使用真实 workerd 和 SQLite Durable Object，验证桥页面、HTTP 会话、真实 WebSocket 升级、并发创建、续期、DELETE 关闭，以及 WebKit `Origin: null` 下的认证和其他网站来源的拒绝。打包通过 Wrangler dry-run。

未使用你的 Cloudflare 账号进行部署，未登录 Telegram 账号做真实端到端测试，也没有对实际线路和速度做保证。部署后建议先连续使用超过 30 分钟，并测试下载文件、关闭重开代理和网络切换。

## 排查

- `/health` 为 500：检查 SECRET、BOOT 和 SESSIONS；BOOT 至少 16 字符，推荐生成的 48 位随机 hex。
- 创建 session 为 503：已达到会话／记录上限。正常关闭旧客户端的代理可释放会话；网络异常遗留的会话最多 30 分钟无活动后失效。持有 SECRET 的用户仍有能力消耗个人代理额度，本版不是公开代理平台。
- 页面空白：普通浏览器直接打开根路径就是空白 Connection 页面，这是预设行为，不是登录网页。
- `/health` 正常但 Telegram 不连接：确认选的是 WEB，域名与客户端填写一致，SECRET 一致，用户能访问该域名，Cloudflare 能访问 Telegram KWS。
- 更新代码：在同一项目目录执行 `npx wrangler deploy`。平台更新可能关闭旧连接，Telegram 应重建会话；不要删除迁移记录或随意改导出的类名。
