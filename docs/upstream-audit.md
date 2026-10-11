# 上游原版代码审查

> 这是修复前的上游版本审查，保留原始复现结论。以下部署方法属于原版；本仓库修正版需要 Durable Object，请按 [修正版部署指南](deployment.md) 操作。后续修复与验证见 [变更记录](../CHANGELOG.md) 和 [故障排查](troubleshooting.md)。

分析日期：2026-10-11。审查版本：`9089a0496219ccbcfcaea261a98dd2a644b3757f`，提交时间为北京时间 2026-10-09 01:19:50。

## 结论

这个项目的架构有实际依据，能作为 Telegram WEB 代理的实验实现；但当前版本存在可复现的会话管理和资源控制问题，建议先修复后用于长期、多人使用。它是 HTTPS/WebSocket 中继，不是一个可以直接填入普通 SOCKS5 或普通 MTProxy 配置的服务。

审查对象只有 README、一个 Worker JS 文件及 GPL-3.0 许可证，没有现成测试、依赖清单或 Wrangler 配置。本次没有修改原仓库代码，没有部署到 Cloudflare，也没有使用 Telegram 账号做端到端测试。下面的“已复现”指对原始函数做本地执行，并以两个独立 JS 上下文模拟两个 Worker isolate；WebSocket 与 Response 的 Cloudflare 部分使用替身。

## 1. 它如何工作

链路是：Telegram 原生客户端 → 客户端内的 WebView → 你的 Cloudflare Worker → Telegram 官方 KWS WebSocket 入口。

客户端按 WEB 代理协议计算域名和 SECRET 对应的 bridge 签名，加载 `https://域名/?bridge=签名`。页面用短期 bootstrap 创建 session，再为每条 Telegram 逻辑流建立独立 WebSocket lane。Worker 解开客户端使用的 MTProxy 传输混淆层，重新生成 Telegram Web K 接受的混淆头，转接至 `kws{1..5}[-1].web.telegram.org/apiws`。

所以无需额外 VPS／MTProxy 后端，但仍取决于用户能否访问 Worker 域名，以及 Cloudflare 到 Telegram 官方入口是否可用。它只解决这条 Telegram 数据传输路径，不是通用 VPN；不能据此保证 Telegram 通话等功能也被代理。

## 2. 怎么使用

### 先确认客户端

- 已检查 Telegram Desktop **v7.3.1** 源码，包含 `WEB` 类型和 `webproxy` 链接解析。仍应检查实际安装版本的代理设置是否显示 WEB。
- Telegram Android 当前 master 源码同样包含 WEB 代理实现；具体发行包、版本和第三方客户端是否支持，需要看实际界面，不能由 master 源码推出所有安装包都支持。
- 仅有 SOCKS5／MTProto 选项时，这个 Worker 不能直接填入对应配置。iOS 本次未做实现核验。

### 部署 Worker

1. 在 Cloudflare 的 Workers & Pages 中创建 Worker，将项目的 `telegram_webproxy.js` 完整作为模块入口代码。
2. 生成两份独立随机值：

   ```bash
   openssl rand -hex 16
   openssl rand -hex 24
   ```

   第一份为 SECRET，32 个十六进制字符；第二份为 BOOT，48 个十六进制字符。
3. 在 Worker 设置中添加两个 secret 绑定，名称严格使用 `SECRET` 和 `BOOT`，填入上述各自的值，部署使其生效。BOOT 是服务端令牌签名密钥，**不需要交给 Telegram 客户端**。
4. 使用该 Worker 的 HTTPS 主机名，可是 workers.dev 子域名，也可是绑定到 Worker 的自有域名。实际线路效果需要测试，协议本身不保证提高速度。
5. 检查配置：

   ```bash
   curl https://你的Worker域名/health
   ```

   正常返回 `{"ok":true}`。这只证明配置通过基本校验、路由能够运行，没有测试 Telegram 上游，也没有验证 BOOT 的随机性。

采用近期 compatibility date；仓库没有固定运行时版本。当前 Cloudflare 文档支持 `new WebSocket(url)` 和 `accept({allowHalfOpen:true})`，不能仅凭旧版 Workers 经验认定这些 API 不存在。

### 配置 Telegram

在支持 WEB 的客户端里进入代理设置，添加 **WEB** 类型：

| 字段 | 填写内容 |
|---|---|
| 服务器 | 你的 Worker 域名，例如 `tgproxy.example.com` |
| 密钥 | Worker 的 SECRET，建议纯 32 位十六进制 |
| 协议／端口 | WEB 类型固定使用 HTTPS／443 |

建议只填主机名，不附带 `/api/v1/ws`、`?bridge=` 或其他路径。项目只实现根路径部署，不支持官方协议的 base path 扩展。更换域名时，客户端服务器字段也必须修改，因为 bridge 签名绑定域名。

支持的客户端还可解析以下格式，替换占位符后使用：

```text
tg://webproxy?server=你的Worker域名&secret=你的SECRET
```

官方文档还定义了 `https://t.me/webproxy?...`，但注明 t.me 网页入口可能未注册该路由，因此实际使用优先考虑手动添加或客户端直接处理 `tg://webproxy`。链接含访问密钥，分享链接等同于分享代理访问权限。

直接在普通浏览器打开域名，看到空白或标题为 Connection 的页面，是代码预设的表现。真正 bridge 页面依赖合法签名和 Telegram WebView 提供的消息接口，不是登录 Telegram 的网页。

## 3. 代码问题

以下源码链接固定到本次审查的提交，避免后续代码变化导致行号失效。

### 高优先级：会话状态依赖 isolate 内的 Map

位置：[全局 leases，L4](https://github.com/ToiCF/CF-Workers-TGProxy/blob/9089a0496219ccbcfcaea261a98dd2a644b3757f/telegram_webproxy.js#L4)、[租约处理，L125–127](https://github.com/ToiCF/CF-Workers-TGProxy/blob/9089a0496219ccbcfcaea261a98dd2a644b3757f/telegram_webproxy.js#L125)。

README 声称所有 lane 会落在同一个 isolate，但代码没有实现任何保证这一点的路由机制。Cloudflare 也不保证独立请求一直使用同一个实例。leases、active、used、deleted 都只是当前实例内存。

**已复现：** 同一个 token/sid 在实例 A 第二次连接返回 409，在实例 B 却返回 101；实例 A 删除 token 后，实例 C 仍允许建立 lane。

影响：SID 不复用、每会话并发数、删除标记都不是全局可靠的约束。基本中继未必因此马上失败，因为 token 可以无状态验签、lane 自带完整头部；问题是控制面承诺失效。

建议：使用 Durable Object 或其他具备可靠、原子会话协调能力的方案管理 active/used/deleted；若坚持完全无状态，应明确删掉当前无法保证的撤销和全局限额语义。

### 高优先级：五分钟过期但没有续期

位置：[mkSess，L31](https://github.com/ToiCF/CF-Workers-TGProxy/blob/9089a0496219ccbcfcaea261a98dd2a644b3757f/telegram_webproxy.js#L31)、[页面 open/create，L104–106](https://github.com/ToiCF/CF-Workers-TGProxy/blob/9089a0496219ccbcfcaea261a98dd2a644b3757f/telegram_webproxy.js#L104)、[新 lane 验签，L124](https://github.com/ToiCF/CF-Workers-TGProxy/blob/9089a0496219ccbcfcaea261a98dd2a644b3757f/telegram_webproxy.js#L124)。

session token 固定五分钟有效，页面只创建一次 session。之后所有 lane 都继续使用相同 token，没有刷新机制。

**已复现：** 前移时钟 301 秒，新 lane 返回 404，已有 lane 没有自动关闭。页面将新 lane 握手失败视为整个 carrier 失败，调用 fail() 关闭其他 lane。

影响：持续使用五分钟后，新增下载流、DC 连接或重连可能导致整个代理重新建立。**不等于所有连接会在第五分钟整点断开**，触发条件是过期后再建 lane。仓库已有[频繁重连的 issue](https://github.com/ToiCF/CF-Workers-TGProxy/issues/1)，但没有足够证据认定该报告一定由这个缺陷导致。

建议：将会话寿命与活动状态绑定并续租，或者实现明确的令牌更新与新旧令牌切换；仅延长固定 TTL 只能推迟问题。

### 高优先级：上游接收队列没有硬上限

位置：[mkWire onData/pack，L49–57](https://github.com/ToiCF/CF-Workers-TGProxy/blob/9089a0496219ccbcfcaea261a98dd2a644b3757f/telegram_webproxy.js#L49)、[emitDn 等待 credit，L82](https://github.com/ToiCF/CF-Workers-TGProxy/blob/9089a0496219ccbcfcaea261a98dd2a644b3757f/telegram_webproxy.js#L82)。

接收数据不断加入 q，qBytes 只用于合包触发，没有用于拒绝或关闭超限 lane。客户端停止返回 WINDOW 后，pump 可以停在 emitDn，但 WebSocket 的 message 处理仍继续把上游消息放入队列。README 中的 8MB/32MB 限额主要存在于页面上行队列，不能保护这个服务端下行队列。

**已复现：** 单个 mkWire 在没有消费者时缓存 10MiB，未触发任何关闭或限制，之后能读回全部数据。

影响：慢客户端或不返还 credit 的认证客户端可能积累内存；Workers 的 128MB 内存额度是每 isolate 共享的。发送侧也直接 ws.send()，不能把调用成功等同于网络已排空。

建议：服务端各级队列设置实际的字节／条目硬上限，设计对上游的背压或超限关闭策略，并约束发送缓冲增长。

### 中优先级：DELETE 不会主动关闭已有 lane

位置：[DELETE，L120](https://github.com/ToiCF/CF-Workers-TGProxy/blob/9089a0496219ccbcfcaea261a98dd2a644b3757f/telegram_webproxy.js#L120)、[onData，L77](https://github.com/ToiCF/CF-Workers-TGProxy/blob/9089a0496219ccbcfcaea261a98dd2a644b3757f/telegram_webproxy.js#L77)。

DELETE 只设置 lease.deleted，没有保存或遍历对应 sess，也没有调用它们的 close。已有 lane 只在下一次客户端消息到达时检查 deleted；下行 pump 不检查。

**已复现：** DELETE 返回 204 后，已有 server WebSocket 的 close() 调用数仍是 0。

正常页面的 close() 自己也会关闭 WebSocket，能缓解日常使用影响，但这不使服务端撤销语义成立。

建议：会话协调层保存活动 lane 的关闭句柄，删除时立即终止全部 lane。这个问题与跨实例问题需要一起修复。

### 中优先级：bootstrap 可重放，DELETE 可绕过租约容量

位置：[authBoot，L32](https://github.com/ToiCF/CF-Workers-TGProxy/blob/9089a0496219ccbcfcaea261a98dd2a644b3757f/telegram_webproxy.js#L32)、[session POST/DELETE，L120](https://github.com/ToiCF/CF-Workers-TGProxy/blob/9089a0496219ccbcfcaea261a98dd2a644b3757f/telegram_webproxy.js#L120)。

bootstrap 只有有效期和 HMAC，没有消费记录。同一 bootstrap 能在有效期内创建任意多个不同 session，和 README 的“一次性”描述不符。authBoot 还接受原始 BOOT 作为凭证；页面实际仅拿到 mkBoot 生成的短期 token，并没有泄漏原始 BOOT。

DELETE 对尚无 lease 的合法 session token 会新建 lease，却不检查 leases.size。4096 的限制只在 WebSocket 创建新 lease 时检查。

**已复现：** 同一 bootstrap 连续 POST 两次得到不同 session token；通过 POST 创建 4100 个 session 并逐个 DELETE，得到 4100 条 lease，随后新的合法 lane 返回 503。复现时固定本地时钟，不代表真实平台上的操作吞吐量。

影响：持有合法 bootstrap 或代理访问权限的人能制造短时容量拒绝，且无全局创建速率限制。过期无活动租约在后续合法 WS 请求时会清理，因此不应描述为永久拒绝服务。随机匿名请求不能凭空绕过 HMAC。

建议：创建时进行统一配额和速率控制；bootstrap 使用原子、幂等消费，同一次创建重试返回同一个 session；DELETE 不应无限制造新的状态。

### 中优先级：SECRET 的格式与官方 WEB 客户端不完全一致

位置：[getKey，L23](https://github.com/ToiCF/CF-Workers-TGProxy/blob/9089a0496219ccbcfcaea261a98dd2a644b3757f/telegram_webproxy.js#L23)。

Worker 接受 32 位 hex，及 dd/ee/ef 前缀加 32 位 hex。Android 当前 WEB 解码只接受 16 字节或 dd 开头的 17 字节；Desktop v7.3.1 同样不接受这里的 ee/ef 17 字节形式，其 WEB 类型还明确拒绝 fake-TLS secret。

影响：按 README 配置 ee/ef 前缀可能出现 /health 正常但客户端不接受密钥的情况。最稳妥做法是使用纯 32 位 hex；dd 形式的签名已通过官方向量核对，但本次没有对真实客户端做全链路验证。

### 文档与性能结论需要修正

- “所有 lane 同 isolate”“一次性 bootstrap”不符合代码和运行时保证。
- “约 2x 起”“1.8x–39.8x”不能当作该项目对 Telegram 的实测结果。README 自己已标注部分推断，并引用另一个核的回放数据；仓库没有本项目基准。
- 当前 write() 对多个包可合并执行 AES，但仍按每个 packet 调用 peer.write()。不能把 upPack=20KB 理解成已将每组小包合成一个上游 WebSocket send。
- Worker 每个方向都要解开一层再加密一层。普通 MTProxy 也不需要解密用户聊天内容，“减少应用消息加解密量”不是证明提速倍数的充分依据。
- 官方协议存在多个 carrier 和 base path 模式，本项目只实现根路径 websocket-lanes，没有备用载体。

## 4. 安全方面的评价

未发现将账号、密钥或流量偷偷发往第三方地址的明显代码路径；出站主机由固定 DC 范围生成，目标是 Telegram 官方域名。Worker 没有 Telegram MTProto 授权密钥，其数据面处理的是传输混淆层，不能据此直接读取用户消息明文。HMAC 有用途隔离，桥接路径及 Origin 检查、随机 nonce CSP 等也有明确实现。

但应区分：Telegram 普通云聊天是客户端与 Telegram 服务器之间的加密，不是聊天双方端到端加密；秘密聊天才有对应的端到端语义。README 的“内层始终端到端”表达不够准确。代理和 Cloudflare 仍能接触连接元数据、流量大小和时间特征；上述资源控制、会话撤销缺陷也意味着不能把它称为已经审计安全的成熟服务。

## 5. 本地验证记录

- JS 模块语法检查通过。
- 官方 bridge 签名向量 2/2 一致，包括 dd 密钥向量。
- 随机分片 AES-CTR 对比 24/24 与 Node 原生实现一致。
- 复现：bootstrap 重放、跨实例 SID 复用、DELETE 不关闭、跨实例删除失效、五分钟后新 lane 拒绝、DELETE 超出租约容量、无消费者时单 lane 缓存 10MiB。
- 原仓库 git status 无修改。

这些验证支持上面的具体结论，不证明 KWS 端点当前可达、Cloudflare 上的实际吞吐量、移动端后台稳定性，或端到端 Telegram 功能完整。

## 6. 建议的处理顺序

先修会话协调和续期，再修服务端队列上限及主动撤销，随后补 bootstrap 幂等消费、容量／速率控制和密钥格式约束。最后在真实 Cloudflare 上测试超过五分钟后的新流、网络切换、慢接收、大文件下载与多客户端并发。当前版本适合小规模实验，尚不建议直接作为长期多人服务。

## 参考

- [本项目审查提交](https://github.com/ToiCF/CF-Workers-TGProxy/tree/9089a0496219ccbcfcaea261a98dd2a644b3757f)
- [官方 WEB 代理协议](https://github.com/telegramdesktop/tproxy-server/blob/master/PROTOCOL.md)
- [官方部署与客户端配置说明](https://github.com/telegramdesktop/tproxy-server/blob/master/README.md)
- [Desktop v7.3.1 代理类型实现](https://github.com/telegramdesktop/tdesktop/blob/v7.3.1/Telegram/SourceFiles/boxes/connection_box.cpp)
- [Desktop v7.3.1 密钥校验实现](https://github.com/telegramdesktop/tdesktop/blob/v7.3.1/Telegram/SourceFiles/mtproto/mtproto_proxy_data.cpp)
- [Android 当前 WEB 传输实现](https://github.com/DrKLO/Telegram/blob/master/TMessagesProj/src/main/java/org/telegram/utils/proxy/WebProxyTransport.java)
- [Cloudflare isolate 运行机制](https://developers.cloudflare.com/workers/reference/how-workers-works/)
- [Cloudflare WebSocket API](https://developers.cloudflare.com/workers/runtime-apis/websockets/)
- [Cloudflare 资源限制](https://developers.cloudflare.com/workers/platform/limits/)
