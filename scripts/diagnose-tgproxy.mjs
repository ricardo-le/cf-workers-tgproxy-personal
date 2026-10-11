// Personal Telegram WEB proxy connectivity diagnostic. Node.js 22+.
// SPDX-License-Identifier: GPL-3.0-only. See ../LICENSE.
import { createCipheriv, createHash, randomBytes } from 'node:crypto';

export function probeRequest(secretHex, dc = 2) {
  const tagged = secretHex.startsWith('dd') && secretHex.length === 34;
  const mode = tagged ? 0xdd : 0xee;
  const secret = Buffer.from(secretHex.slice(-32), 'hex');
  let head;
  do { head = randomBytes(64); }
  while (head[0] === 0xef || ['HEAD', 'POST', 'GET ', 'OPTI'].includes(head.subarray(0, 4).toString()) || head.readUInt32LE(4) === 0);
  head.fill(mode, 56, 60);
  head.writeInt16LE(dc, 60);
  const cipher = (reverse) => {
    const material = Buffer.from(head.subarray(8, 56));
    if (reverse) material.reverse();
    const key = createHash('sha256').update(material.subarray(0, 32)).update(secret).digest();
    return createCipheriv('aes-256-ctr', key, material.subarray(32, 48));
  };
  const up = cipher(false), down = cipher(true);
  const wireHead = up.update(head);
  head.copy(wireHead, 0, 0, 56);
  const nonce = randomBytes(16);
  const message = Buffer.alloc(40);
  const now = Date.now();
  message.writeBigUInt64LE((BigInt(Math.floor(now / 1000)) << 32n) | (BigInt(now % 1000) << 22n), 8);
  message.writeUInt32LE(20, 16);
  message.writeUInt32LE(0xbe7e8ef1, 20); // req_pq_multi: no account, login or message access.
  nonce.copy(message, 24);
  const padded = tagged ? Buffer.concat([message, randomBytes(8)]) : message;
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(padded.length);
  let received = Buffer.alloc(0);
  return {
    wire: Buffer.concat([wireHead, up.update(Buffer.concat([prefix, padded]))]),
    consume(raw) {
      received = Buffer.concat([received, down.update(raw)]);
      if (received.length < 4) return false;
      const size = received.readUInt32LE();
      if (size < 40 || size > 1024 * 1024) throw new Error('上游返回异常的 MTProto 传输长度。');
      if (received.length < size + 4) return false;
      const packet = received.subarray(4, size + 4);
      if (packet.readBigUInt64LE() !== 0n || packet.readUInt32LE(20) !== 0x05162463 || !packet.subarray(24, 40).equals(nonce)) {
        throw new Error('上游响应未通过 resPQ 与随机 nonce 校验。');
      }
      return true;
    },
  };
}

export function frame(type, sid, payload = Buffer.alloc(0)) {
  const result = Buffer.alloc(8 + payload.length);
  result[0] = type;
  result.writeUIntBE(sid, 1, 3);
  result.writeUInt32BE(payload.length, 4);
  payload.copy(result, 8);
  return result;
}

export function parseFrames(raw) {
  const bytes = Buffer.from(raw), result = [];
  for (let offset = 0; offset < bytes.length;) {
    if (bytes.length - offset < 8) throw new Error('Worker 返回不完整的帧头。');
    const length = bytes.readUInt32BE(offset + 4);
    if (length > 1024 * 1024 || offset + 8 + length > bytes.length) throw new Error('Worker 返回异常的帧长度。');
    result.push({ type: bytes[offset], sid: bytes.readUIntBE(offset + 1, 3), payload: bytes.subarray(offset + 8, offset + 8 + length) });
    offset += 8 + length;
  }
  return result;
}

import { createHmac } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const steps = ['健康检查', '桥页面与 SECRET 签名', 'Durable Object 会话', 'Worker WebSocket', 'Telegram 上游协议响应'];
export async function diagnose(host, secret, options = {}) {
  const request = options.fetchImpl || fetch;
  const Socket = options.WebSocketImpl || WebSocket;
  const log = options.log || console.log;
  const timeoutMs = options.timeoutMs || 20000;
  const origin = `https://${host}`;
  let step = 0, token = '', socket = null;
  const http = async (path, init = {}) => {
    try {
      return await request(origin + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw Error('请求失败或超时；检查当前网络、HTTPS 和是否存在重定向。');
    }
  };
  const expect = (condition, message) => { if (!condition) throw Error(message); };
  const pass = (note) => log(`[通过] ${steps[step]}：${note}`);
  try {
    expect(/^(?:[0-9a-f]{32}|dd[0-9a-f]{32})$/.test(secret), 'SECRET 应为 32 位 hex，或 dd 加 32 位 hex。');
    expect(/^[a-z0-9.-]+$/.test(host) && host.includes('.') && !host.endsWith('.'), '请仅填写域名，不带协议、端口或路径。');
    const health = await http('/health');
    expect(health.status === 200, `HTTP ${health.status}；先检查 Worker 配置。`);
    const info = await health.json().catch(() => null);
    expect(info?.ok === true, '返回内容不是预期健康检查 JSON。');
    pass(`HTTP 200，variant=${info.variant === 'personal-fixed' ? 'personal-fixed' : '其他版本'}`);

    step = 1;
    const cap = createHmac('sha256', Buffer.from(secret, 'hex')).update(`tdesktop-web-proxy-bridge-v1\n${host}`).digest('base64url');
    const page = await http('/?bridge=' + cap);
    expect(page.status === 200, `HTTP ${page.status}；桥页面被拦截。`);
    const bootstrap = /boot="([A-Za-z0-9_-]{43})"/.exec(await page.text())?.[1];
    expect(bootstrap, '未获得签名 bootstrap。请核对输入的 SECRET 是否与 Worker 的 SECRET 完全一致，以及域名路由。');
    pass('已获得签名 bootstrap（凭证不输出）');

    step = 2;
    const response = await http('/api/v1/session', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bootstrap}`, Origin: origin, 'Content-Type': 'application/octet-stream' },
      body: Buffer.from([16, 0, 0, 0, 0, 0, 0, 1, 1]),
    });
    const candidate = response.headers.get('X-Session-Token');
    if (candidate && /^[A-Za-z0-9_-]{43}$/.test(candidate)) token = candidate;
    let hint = '检查会话握手与 Durable Object。';
    if (response.status === 503) hint = '会话或记录额度已满；停止两端代理，让无活动会话过期，或检查 Cloudflare 配额。';
    if (response.status === 404) hint = 'bootstrap、Origin 或 HELLO 被拒绝；需要查看服务端诊断。';
    if (response.status >= 500 && response.status !== 503) hint = '检查 Durable Object 绑定、迁移、Cloudflare 配额及异常。';
    expect(response.status === 200, `POST 返回 HTTP ${response.status}；${hint}`);
    expect(response.headers.get('X-Carrier-Mode') === 'websocket-lanes' && token, 'HTTP 200，但缺少预期会话响应头。');
    const welcome = Buffer.from(await response.arrayBuffer());
    expect(welcome.equals(Buffer.from([17, 0, 0, 0, 0, 0, 0, 0])), 'WELCOME 帧不是预期的 8 字节。');
    pass('POST HTTP 200，响应头与 WELCOME 帧正确');

    step = 3;
    const probe = probeRequest(secret);
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => finish(Error('等待超时；未收到有效响应。')), timeoutMs);
      try {
        const protocol = `tproxy-lane-v1.${token}.1`;
        socket = new Socket(`wss://${host}/api/v1/ws`, protocol);
        socket.binaryType = 'arraybuffer';
        socket.addEventListener('open', () => {
          try {
            expect(socket.protocol === protocol, '子协议不匹配。');
            pass('WebSocket 已升级，子协议正确');
            step = 4;
            socket.send(frame(1, 1));
            socket.send(frame(2, 1, probe.wire));
          } catch (error) { finish(error); }
        });
        socket.addEventListener('message', event => {
          try {
            for (const item of parseFrames(event.data)) {
              expect(item.sid === 1, '收到意外的 stream ID。');
              if (item.type === 2 && probe.consume(item.payload)) {
                pass('收到有效 resPQ，随机 nonce 校验通过（DC 2）');
                finish();
              }
              if (item.type === 3 && !settled) finish(Error('流被 Worker 关闭；检查上游连接、传输解析与配额。'));
            }
          } catch (error) { finish(error); }
        });
        socket.addEventListener('error', () => finish(Error('WebSocket 出错；检查升级、认证、网络和 Worker 异常。')));
        socket.addEventListener('close', event => finish(Error(`WebSocket 关闭，code=${event.code}；未完成协议响应。`)));
      } catch { finish(Error('无法创建 WebSocket；请使用 Node.js 22 或更新版本。')); }
    });
    log('[结论] 该电脑到实际 Worker、会话、WebSocket 和 Telegram DC 2 链路通过。');
    log('[范围] 未模拟 Telegram 内置 WebView，未登录账号，未验证其他 DC 或全部功能。');
    return { ok: true, step: steps[step] };
  } catch (error) {
    log(`[失败] ${steps[step]}：${error.message}`);
    return { ok: false, step: steps[step] };
  } finally {
    try { socket?.close(); } catch {}
    if (token) {
      try {
        const removed = await http('/api/v1/session', { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, Origin: origin } });
        log(removed.status === 204 ? '[清理] 诊断会话已删除。' : `[清理] DELETE 返回 HTTP ${removed.status}，会话将按服务端租约过期。`);
      } catch { log('[清理] DELETE 请求未完成，会话将按服务端租约过期。'); }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = (process.argv[2] || '').trim().toLowerCase();
  if (!host) {
    console.error('用法：node scripts/diagnose-tgproxy.mjs <Worker域名>');
    process.exit(1);
  }
  console.log(`检测域名：${host}`);
  console.log('使用客户端填写的 SECRET；不需要 BOOT。不会打印或保存密钥与令牌。');
  console.log('将创建一个临时会话，发送无账号的 Telegram 协议探测，然后删除会话。');
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const reader = createInterface({ input: process.stdin, output: muted, terminal: Boolean(process.stdin.isTTY) });
  process.stdout.write('请输入 SECRET（输入不回显）：');
  try {
    const secret = (await reader.question('')).trim().toLowerCase();
    reader.close();
    process.stdout.write('\n');
    const result = await diagnose(host, secret);
    if (!result.ok) process.exitCode = 1;
  } finally { reader.close(); }
}
