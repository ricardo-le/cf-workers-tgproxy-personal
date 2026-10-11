// Derived from ToiCF/CF-Workers-TGProxy, commit 9089a0496219.
// Modified 2026-10-11: coordinated sessions, renewal, bounded queues, WebKit origins.
// SPDX-License-Identifier: GPL-3.0-only. See LICENSE.
const CFG = {
  dnPack: 32 * 1024,
  upPack: 20 * 1024,
  dnMs: 1,
  tokenMs: 30 * 60 * 1000,
  idleMs: 30 * 60 * 1000,
  renewMs: 5 * 60 * 1000,
  maxSessions: 4,
  maxRecords: 256,
  maxLanes: 32,
  maxUsed: 4096,
  laneBytes: 8 * 1024 * 1024,
  laneItems: 1024,
  totalBytes: 32 * 1024 * 1024,
  totalItems: 8192,
  openMs: 30000,
};
export default { fetch: (req, env) => route(req, env) };
const txt = new TextEncoder(),
  dec = new TextDecoder(),
  nil = new Uint8Array(0),
  badHead = new Set(["HEAD", "POST", "GET ", "OPTI"]);
const CRYPTO = globalThis.crypto,
  macKeys = new Map();
function mkBudget(bytesLimit = CFG.totalBytes, itemsLimit = CFG.totalItems) {
  let bytes = 0,
    items = 0;
  return {
    reserve(n, count = 1) {
      if (
        n < 0 ||
        count < 0 ||
        bytes + n > bytesLimit ||
        items + count > itemsLimit
      )
        throw Error("queue limit");
      bytes += n;
      items += count;
    },
    release(n, count = 1) {
      bytes -= n;
      items -= count;
      if (bytes < 0 || items < 0) throw Error("queue accounting");
    },
    get bytes() {
      return bytes;
    },
    get items() {
      return items;
    },
  };
}
const reply = (body = null, status = 404) => new Response(body, { status });
function u8(v) {
  if (v instanceof Uint8Array && v.constructor === Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v))
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw TypeError();
}
const dup = (v) => u8(v).slice();
function cat(...args) {
  const parts = args.filter((v) => v?.byteLength).map(u8);
  const out = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.byteLength;
  }
  return out;
}
const hex = (v) =>
  Uint8Array.from({ length: v.length / 2 }, (_, i) =>
    Number.parseInt(v.slice(i * 2, i * 2 + 2), 16),
  );
function b64(v) {
  const b = v instanceof Uint8Array ? v : new Uint8Array(v);
  return btoa(String.fromCharCode(...b))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
const un64 = (v) => {
  const s = v.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(s + "=".repeat((4 - (s.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );
};
const rand = (n) => CRYPTO.getRandomValues(new Uint8Array(n));
const wake = (st) => {
  const { wake: ok } = st;
  st.wake = null;
  ok?.();
};
const isType = (t) => t === 1 || t === 2 || t === 3 || t === 4 || t === 17;
function enc(type, sid, data = nil) {
  const body = u8(data);
  if (!isType(type)) throw RangeError();
  if (!Number.isInteger(sid) || sid < 0 || sid > 0xffffff) {
    throw RangeError();
  }
  if (body.byteLength > 1024 * 1024) throw RangeError();
  const frame = new Uint8Array(8 + body.byteLength);
  frame[0] = type;
  frame[1] = sid >>> 16;
  frame[2] = sid >>> 8;
  frame[3] = sid;
  new DataView(frame.buffer).setUint32(4, body.byteLength, false);
  frame.set(body, 8);
  return frame;
}
function getFrame(b, o) {
  if (b.byteLength - o < 8) return null;
  const type = b[o];
  if (!isType(type)) throw Error();
  const view = new DataView(b.buffer, b.byteOffset + o, b.byteLength - o);
  const sid = (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
  const n = view.getUint32(4, false);
  if (n > 1024 * 1024) throw Error();
  const total = 8 + n;
  if (b.byteLength - o < total) return null;
  return {
    frame: { type, sid, payload: b.subarray(o + 8, o + total) },
    consumed: total,
  };
}
function frames(v) {
  const src = u8(v),
    out = [];
  for (let o = 0; o < src.byteLength;) {
    const part = getFrame(src, o);
    if (!part) throw Error();
    if (out.length >= 4096) throw Error();
    out.push(part.frame);
    o += part.consumed;
  }
  return out;
}
function win(data) {
  const body = u8(data);
  if (body.byteLength !== 4) throw Error();
  const n = new DataView(body.buffer, body.byteOffset, 4).getUint32(0, false);
  if (!n) throw Error();
  return n;
}
function check(frame) {
  const { type, payload: data } = frame;
  if (type === 1 || type === 3) {
    if (data.byteLength) throw Error();
    return 0;
  }
  if (type === 2) {
    if (!data.byteLength) throw Error();
    return 0;
  }
  if (type === 4) return win(data);
  throw Error();
}
const i16 = (b, o) => ((b[o] | (b[o + 1] << 8)) << 16) >> 16;
function headOf(head) {
  const tag = new DataView(
    head.buffer,
    head.byteOffset,
    head.byteLength,
  ).getUint32(56, true);
  const mode =
    tag === 0xefefefef
      ? 0xef
      : tag === 0xeeeeeeee
        ? 0xee
        : tag === 0xdddddddd
          ? 0xdd
          : 0;
  if (!mode) throw Error();
  const dc = i16(head, 60);
  const target = Math.abs(dc) - 1;
  if (target < 0 || target >= 5) throw Error();
  return { mode, target, media: dc < 0 };
}
function mkHead(mode, target, media) {
  const head = new Uint8Array(64);
  do {
    CRYPTO.getRandomValues(head);
  } while (
    head[0] === 0xef ||
    badHead.has(dec.decode(head.subarray(0, 4))) ||
    head.subarray(4, 8).every((v) => v === 0)
  );
  head.fill(mode, 56, 60);
  new DataView(head.buffer).setInt16(60, (target + 1) * (media ? -1 : 1), true);
  return head;
}
function getKey(v, keepTag = false) {
  const str = String(v || "")
    .trim()
    .toLowerCase();
  if (!/^(?:[0-9a-f]{32}|dd[0-9a-f]{32})$/.test(str)) {
    throw Error();
  }
  return hex(
    keepTag && str.length === 34 && str.startsWith("dd") ? str : str.slice(-32),
  );
}
function hostOf(v) {
  const host = String(v || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  const labels = host.split(".");
  if (
    !host.includes(".") ||
    host.length > 253 ||
    host.includes(":") ||
    labels.some(
      (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    )
  ) {
    throw Error();
  }
  return host;
}
const macKey = (raw, id) => {
  let key = macKeys.get(id);
  if (!key)
    macKeys.set(
      id,
      (key = CRYPTO.subtle.importKey(
        "raw",
        u8(raw),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      )),
    );
  return key;
};
const sign = async (key, v) =>
  new Uint8Array(await CRYPTO.subtle.sign("HMAC", await key, u8(v)));
async function mac(boot, kind, body) {
  const prefix = txt.encode(`${kind}\n`);
  const msg = new Uint8Array(prefix.byteLength + body.byteLength);
  msg.set(prefix);
  msg.set(body, prefix.byteLength);
  return (await sign(macKey(txt.encode(boot), `token:${boot}`), msg)).slice(
    0,
    16,
  );
}
async function mkToken(boot, kind, expAt, nonce) {
  const body = new Uint8Array(4 + 12);
  const exp = Math.ceil(expAt / 1000);
  new DataView(body.buffer).setUint32(0, exp, false);
  body.set(nonce, 4);
  const token = new Uint8Array(32);
  token.set(body);
  token.set(await mac(boot, kind, body), body.byteLength);
  return b64(token);
}
const mkBoot = async (boot) =>
  mkToken(boot, "bootstrap", Date.now() + 2 * 60 * 1000, rand(12));
async function verify(v, boot, kind, allowExpired = false) {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(v)) return false;
  let token;
  try {
    token = un64(v);
  } catch {
    return false;
  }
  if (token.byteLength !== 32 || b64(token) !== v) return false;
  const body = token.slice(0, 4 + 12);
  const sig = token.slice(body.byteLength);
  const exp = new DataView(
    body.buffer,
    body.byteOffset,
    body.byteLength,
  ).getUint32(0, false);
  if (!allowExpired && exp <= Math.floor(Date.now() / 1000)) return false;
  const want = await mac(boot, kind, body);
  let diff = sig.byteLength ^ want.byteLength;
  for (let i = 0; i < want.length; i++) diff |= sig[i] ^ want[i];
  return diff === 0;
}
const bearer = (v) => /^Bearer ([^\s]+)$/.exec(v || "")?.[1] ?? null;
const binary = (req) =>
  req.headers.get("Content-Type")?.trim().toLowerCase() ===
  "application/octet-stream";
// Sandboxed WKWebView requests can send Origin: null even with allow-same-origin.
// This metadata check is followed by signed bootstrap/session/lane authentication;
// an opaque origin alone never authorizes a request. Keep other origins rejected.
const originAllowed = (req, url) => {
  const origin = req.headers.get("Origin");
  return origin === null || origin === "null" || origin === url.origin;
};
function hello(body) {
  if (
    body.byteLength !== 9 ||
    body[0] !== 0x10 ||
    body[1] !== 0 ||
    body[2] !== 0 ||
    body[3] !== 0 ||
    new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(
      4,
      false,
    ) !== 1 ||
    body[8] !== 1
  ) {
    throw Error();
  }
}
const protos = (req) =>
  (req.headers.get("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
const mkCfg = ({ SECRET, BOOT }) => {
  const secret = String(SECRET || "").trim(),
    boot = String(BOOT || "").trim();
  if (!secret) throw Error();
  if (boot.length < 16) throw Error();
  if (!SECRET || !BOOT) throw Error();
  return { secret, key: getKey(secret), boot };
};
async function mkCap(secret, host) {
  const key = macKey(
    getKey(secret, true),
    `bridge:${String(secret).trim().toLowerCase()}`,
  );
  const sig = await sign(
    key,
    txt.encode(`tdesktop-web-proxy-bridge-v1\n${hostOf(host)}`),
  );
  return b64(sig);
}
async function bridge(url, secret) {
  if (url.pathname !== "/" || url.search.length !== 51) return null;
  const cand = url.search.slice(8);
  if (url.search !== `?bridge=${cand}` || !/^[A-Za-z0-9_-]{43}$/.test(cand))
    return null;
  const host = hostOf(url.hostname);
  const want = await mkCap(secret, host);
  if (cand.length !== want.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++)
    diff |= cand.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0 ? host : null;
}
const sha = async (v) =>
  new Uint8Array(await CRYPTO.subtle.digest("SHA-256", u8(v)));
function step(ctr, n) {
  let carry = n;
  for (let i = ctr.length - 1; i >= 0 && carry; i--) {
    const next = ctr[i] + (carry & 0xff);
    ctr[i] = next & 0xff;
    carry = Math.floor(carry / 256) + Math.floor(next / 256);
  }
  if (carry) throw Error();
}
const mkCtr = (key, ctr) => {
  let iv = dup(ctr),
    tail = nil;
  const ready = CRYPTO.subtle.importKey(
    "raw",
    u8(key),
    { name: "AES-CTR" },
    false,
    ["encrypt"],
  );
  const crypt = async (v) => {
    const b = u8(v);
    if (!b.byteLength) return new Uint8Array(0);
    const key = await ready;
    if (!tail.byteLength && !(b.byteLength % 16)) {
      const raw = new Uint8Array(
        await CRYPTO.subtle.encrypt(
          { name: "AES-CTR", counter: iv.slice(), length: 128 },
          key,
          b,
        ),
      );
      step(iv, b.byteLength / 16);
      return raw;
    }
    if (b.byteLength <= tail.byteLength) {
      const out = new Uint8Array(b.byteLength);
      for (let i = 0; i < b.byteLength; i++) out[i] = b[i] ^ tail[i];
      tail = tail.slice(b.byteLength);
      return out;
    }
    const skip = tail.byteLength ? 16 - tail.byteLength : 0;
    const ctr = iv.slice();
    if (skip) {
      for (let i = ctr.length - 1; i >= 0; i--) if (ctr[i]--) break;
    }
    const end = skip + b.byteLength;
    const block = new Uint8Array(Math.ceil(end / 16) * 16);
    block.set(b, skip);
    const raw = new Uint8Array(
      await CRYPTO.subtle.encrypt(
        { name: "AES-CTR", counter: ctr, length: 128 },
        key,
        block,
      ),
    );
    tail = raw.slice(end);
    step(iv, block.byteLength / 16 - (skip ? 1 : 0));
    return raw.subarray(skip, end);
  };
  return { crypt };
};
async function cipher(head, secret, reverse) {
  const mat = dup(u8(head).subarray(8, 56));
  if (reverse) mat.reverse();
  const key = secret.byteLength
    ? await sha(cat(mat.subarray(0, 32), secret))
    : mat.subarray(0, 32);
  return mkCtr(key, mat.subarray(32, 48));
}
async function wireHead(head) {
  const ctr = await cipher(head, nil, false);
  const raw = await ctr.crypt(head);
  raw.set(u8(head).subarray(0, 56));
  return { wire: raw, cipher: ctr };
}
const hosts = (dc, media) => [
  `kws${dc}${media ? "-1" : ""}.web.telegram.org`,
  `kws${dc}${media ? "" : "-1"}.web.telegram.org`,
];
async function dial({ target, media, signal, budget }) {
  for (const host of hosts(target + 1, media)) {
    if (signal?.aborted) throw Error();
    const url = `wss://${host}/apiws`;
    let kws;
    try {
      kws = mkWire(new WebSocket(url, "binary"), 7500, signal, budget);
      await kws.ready;
      if (signal?.aborted) throw Error();
      return kws;
    } catch (err) {
      kws?.close();
      if (signal?.aborted) throw err;
    }
  }
  throw Error();
}
const mkWire = (ws, ms, signal, budget = mkBudget()) => {
  const q = [],
    wait = [],
    held = new Map();
  let h = 0,
    qBytes = 0,
    heldBytes = 0,
    heldItems = 0,
    closed = false,
    dead = false,
    up = false,
    fault = null;
  let pWake = null,
    pNeed,
    openTimer,
    readyOk,
    readyBad;
  const ready = new Promise((ok, bad) => {
    readyOk = ok;
    readyBad = bad;
  });
  const onAbort = () => {
    end(Error());
    close();
  };
  const onOpen = () => {
    if (closed) return;
    if (ws.protocol !== "binary") {
      end(Error());
      close();
      return;
    }
    up = true;
    clearTimeout(openTimer);
    readyOk(api);
  };
  const onData = (v) => {
    if (closed) return;
    let b;
    try {
      if (typeof v === "string") throw Error();
      b = u8(v);
    } catch {
      end(Error());
      close();
      return;
    }
    if (!b.byteLength) return;
    if (b.byteLength > CFG.laneBytes) {
      end(Error());
      close();
      return;
    }
    if (
      qBytes + heldBytes + b.byteLength > CFG.laneBytes ||
      q.length - h + heldItems >= CFG.laneItems
    ) {
      end(Error());
      close();
      return;
    }
    try {
      budget.reserve(b.byteLength, 1);
    } catch {
      end(Error());
      close();
      return;
    }
    const waiter = wait.shift();
    if (waiter) {
      held.set(b, 1);
      heldBytes += b.byteLength;
      heldItems++;
      waiter.resolve(b);
    } else {
      q.push(b);
      qBytes += b.byteLength;
      if (pWake && (qBytes >= pNeed || b.byteLength >= CFG.dnPack)) pWake();
    }
  };
  const end = (err = null) => {
    if (closed) return;
    closed = true;
    fault = err;
    clearTimeout(openTimer);
    signal?.removeEventListener("abort", onAbort);
    if (!up) readyBad(err || Error());
    pWake?.();
    for (const waiter of wait.splice(0))
      err ? waiter.reject(err) : waiter.resolve(null);
  };
  const write = async (v) => {
    await ready;
    if (closed) throw fault || Error();
    ws.send(u8(v));
  };
  const take = async () => {
    await ready;
    if (h < q.length) {
      const msg = q[h];
      q[h++] = null;
      qBytes -= msg.byteLength;
      held.set(msg, 1);
      heldBytes += msg.byteLength;
      heldItems++;
      trim();
      return msg;
    }
    if (fault) throw fault;
    if (closed) return null;
    return new Promise((ok, bad) => wait.push({ resolve: ok, reject: bad }));
  };
  const pack = async () => {
    const first = await take();
    if (dead) return null;
    if (!first || first.byteLength >= CFG.dnPack) return first;
    if (!closed && qBytes < CFG.dnPack - first.byteLength) {
      await new Promise((ok) => {
        pNeed = CFG.dnPack - first.byteLength;
        const timer = setTimeout(() => pWake?.(), CFG.dnMs);
        pWake = () => {
          clearTimeout(timer);
          pWake = null;
          ok();
        };
      });
    }
    if (dead) return null;
    let n = first.byteLength,
      end = h;
    while (end < q.length && n + q[end].byteLength <= CFG.dnPack) {
      n += q[end++].byteLength;
    }
    if (end === h) return first;
    const b = new Uint8Array(n);
    b.set(first);
    let items = held.get(first);
    held.delete(first);
    let o = first.byteLength;
    while (h < end) {
      const part = q[h];
      q[h++] = null;
      b.set(part, o);
      o += part.byteLength;
      qBytes -= part.byteLength;
      heldBytes += part.byteLength;
      heldItems++;
      items++;
    }
    held.set(b, items);
    trim();
    return b;
  };
  const trim = () => {
    if (h === q.length) {
      q.length = 0;
      h = 0;
    } else if (h >= 256 && h * 2 >= q.length) {
      q.splice(0, h);
      h = 0;
    }
  };
  const releasePack = (b) => {
    const items = held.get(b);
    if (!items) return;
    held.delete(b);
    heldBytes -= b.byteLength;
    heldItems -= items;
    budget.release(b.byteLength, items);
  };
  const close = () => {
    if (dead) return;
    dead = true;
    if (!closed) end();
    budget.release(qBytes + heldBytes, q.length - h + heldItems);
    held.clear();
    heldBytes = heldItems = 0;
    q.length = h = qBytes = 0;
    try {
      ws.close(1000);
    } catch {}
  };
  const api = {
    ready,
    write,
    readPack: pack,
    releasePack,
    close,
    get closed() {
      return closed;
    },
    get queuedBytes() {
      return qBytes;
    },
  };
  ws.binaryType = "arraybuffer";
  ws.addEventListener("open", onOpen);
  ws.addEventListener("message", (e) => onData(e.data));
  ws.addEventListener("error", () => end(Error()));
  ws.addEventListener("close", (e) =>
    end(e?.code && e.code !== 1000 ? Error() : null),
  );
  openTimer = setTimeout(() => {
    end(Error());
    close();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return api;
};
const mkPkt = (mode, budget = mkBudget()) => {
  let tail = nil;
  const held = new Set();
  const push = (v) => {
    const b = u8(v);
    if (b.byteLength) {
      budget.reserve(b.byteLength, 0);
      tail = tail.byteLength ? cat(tail, b) : b;
    }
    const pkts = [];
    let o = 0;
    try {
      for (;;) {
        const avail = tail.byteLength - o;
        let hLen;
        let pLen;
        if (mode === 0xef) {
          if (avail < 1) break;
          let words = tail[o] & 0x7f;
          if (words === 0x7f) {
            if (avail < 4) break;
            words = tail[o + 1] | (tail[o + 2] << 8) | (tail[o + 3] << 16);
            hLen = 4;
          } else hLen = 1;
          pLen = words * 4;
        } else {
          if (avail < 4) break;
          pLen =
            new DataView(tail.buffer, tail.byteOffset + o, 4).getUint32(
              0,
              true,
            ) & 0x7fffffff;
          hLen = 4;
        }
        if (!pLen || pLen > 8 * 1024 * 1024) throw Error();
        const total = hLen + pLen;
        if (avail < total) break;
        if (held.size >= CFG.laneItems) throw Error("packet item limit");
        budget.reserve(0, 1);
        const packet = tail.subarray(o, o + total);
        held.add(packet);
        pkts.push(packet);
        o += total;
      }
    } finally {
      if (o) {
        tail = o === tail.byteLength ? nil : tail.slice(o);
      }
    }
    if (tail.byteLength > 8 * 1024 * 1024 + 4) throw Error();
    return pkts;
  };
  const clear = () => {
    budget.release(
      tail.byteLength +
        [...held].reduce((n, packet) => n + packet.byteLength, 0),
      held.size,
    );
    held.clear();
    tail = nil;
  };
  const releasePacket = (packet) => {
    if (held.delete(packet)) budget.release(packet.byteLength, 1);
  };
  return { push, clear, releasePacket };
};
const mkStream = ({ secret, emit, onClose, budget = mkBudget() }) => {
  let hdr = nil,
    cIn = null,
    cOut = null,
    kIn = null,
    kOut = null,
    peer = null,
    pkt = null;
  let init = false,
    closed = false,
    chain = Promise.resolve();
  const ac = new AbortController(),
    uq = new Set();
  const push = (v) => {
    if (closed) return Promise.reject(Error());
    const job = { bytes: u8(v) };
    uq.add(job);
    chain = chain.then(async () => {
      if (closed) throw Error();
      if (!job.bytes) return job.result;
      const jobs = [job];
      let n = job.bytes.byteLength;
      for (const next of uq) {
        if (next === job) continue;
        if (n >= CFG.upPack || n + next.bytes.byteLength > CFG.upPack) break;
        n += next.bytes.byteLength;
        jobs.push(next);
      }
      const b =
        jobs.length === 1 ? job.bytes : cat(...jobs.map((x) => x.bytes));
      for (const item of jobs) {
        uq.delete(item);
        item.bytes = null;
      }
      const out = await feed(b);
      for (const item of jobs) item.result = out;
      return out;
    });
    return chain;
  };
  const feed = async (b) => {
    if (closed) throw Error();
    if (init && peer.closed) return false;
    if (!b.byteLength) return;
    if (!init) {
      const need = 64 - hdr.byteLength;
      if (b.byteLength < need) {
        hdr = cat(hdr, b);
        return;
      }
      hdr = cat(hdr, b.subarray(0, need));
      await start();
      const rest = b.subarray(need);
      if (rest.byteLength) return write(rest);
      return;
    }
    return write(b);
  };
  const start = async () => {
    const raw = hdr;
    const cr = await cipher(raw, secret, false);
    const plain = await cr.crypt(raw);
    if (closed) return;
    const info = headOf(plain);
    const head = mkHead(info.mode, info.target, info.media);
    const [cw, out, kr] = await Promise.all([
      cipher(raw, secret, true),
      wireHead(head),
      cipher(head, nil, true),
    ]);
    if (closed) return;
    const kws = await dial({
      target: info.target,
      media: info.media,
      signal: ac.signal,
      budget,
    });
    if (closed) {
      kws.close();
      return;
    }
    peer = kws;
    cIn = cr;
    cOut = cw;
    kOut = out.cipher;
    kIn = kr;
    pkt = mkPkt(info.mode, budget);
    await kws.write(out.wire);
    if (closed) return;
    hdr = nil;
    init = true;
    pump().catch(() => close());
  };
  const write = async (raw) => {
    if (closed || peer.closed) return false;
    const parser = pkt;
    let pkts;
    budget.reserve(raw.byteLength, 0);
    try {
      const plain = await cIn.crypt(raw);
      if (closed || peer.closed) return false;
      pkts = parser.push(plain);
    } finally {
      budget.release(raw.byteLength, 0);
    }
    try {
      for (let start = 0; start < pkts.length;) {
        let end = start + 1,
          n = pkts[start].byteLength;
        while (end < pkts.length && n + pkts[end].byteLength <= CFG.upPack) {
          n += pkts[end++].byteLength;
        }
        const first = pkts[start];
        const b =
          end === start + 1
            ? first
            : new Uint8Array(first.buffer, first.byteOffset, n);
        if (closed || peer.closed) return false;
        budget.reserve(n, 0);
        try {
          const wire = await kOut.crypt(b);
          for (let o = 0; start < end; start++) {
            if (closed || peer.closed) return false;
            const n = pkts[start].byteLength;
            try {
              await peer.write(wire.subarray(o, o + n));
            } catch (err) {
              if (closed || peer.closed) return false;
              throw err;
            }
            o += n;
            parser.releasePacket(pkts[start]);
          }
        } finally {
          budget.release(n, 0);
        }
      }
    } finally {
      for (const packet of pkts) parser.releasePacket(packet);
    }
  };
  const pump = async () => {
    while (!closed) {
      const source = peer;
      const b = await source.readPack();
      if (closed) return;
      if (!b) return close();
      let scratch = 0;
      try {
        budget.reserve(b.byteLength * 2, 0);
        scratch = b.byteLength * 2;
        const plain = await kIn.crypt(b);
        if (closed) return;
        const raw = await cOut.crypt(plain);
        if (closed) return;
        await emit(raw);
      } finally {
        if (scratch) budget.release(scratch, 0);
        source.releasePack(b);
      }
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    ac.abort();
    try {
      peer?.close();
    } catch {}
    for (const job of uq) job.bytes = null;
    uq.clear();
    hdr = nil;
    pkt?.clear();
    cIn = cOut = kIn = kOut = peer = null;
    try {
      onClose();
    } catch {}
  };
  return { push, close };
};
const mkSession = ({
  secret,
  sid,
  onClose,
  lease,
  budget = mkBudget(),
  onActivity = () => {},
}) => {
  let sock = null,
    closed = false,
    tx = Promise.resolve(),
    cur = null;
  let openTimer = setTimeout(() => close(1008), CFG.openMs);
  const attach = (ws) => {
    if (sock || closed) throw Error();
    sock = ws;
    ws.binaryType = "arraybuffer";
    ws.accept({ allowHalfOpen: true });
    ws.addEventListener("message", (e) => {
      if (closed) return;
      try {
        onData(e.data);
      } catch {
        close(1008);
      }
    });
    ws.addEventListener("close", () => close());
    ws.addEventListener("error", () => close());
  };
  const onData = (v) => {
    if (closed) return;
    if (lease?.deleted) {
      return close(1000);
    }
    if (typeof v === "string") throw Error();
    const b = v instanceof Uint8Array ? v : new Uint8Array(v);
    if (!b.byteLength || b.byteLength > 2 * 1024 * 1024) {
      throw Error();
    }
    for (const frame of frames(b)) {
      if (closed) return;
      const delta = check(frame);
      onActivity();
      if (frame.sid !== sid) throw Error();
      if (!cur && frame.type !== 1) throw Error();
      if (frame.type !== 1 && cur?.closed) continue;
      if (frame.type === 1) open();
      else if (frame.type === 2) write(frame.payload);
      else if (frame.type === 4) grant(delta);
      else if (frame.type === 3) end(false);
      else throw Error();
    }
  };
  const send = (type, data = nil) => {
    const out = enc(type, sid, data);
    const st = type === 2 || type === 4 ? cur : null;
    tx = tx.then(() => {
      if (closed) throw Error();
      if ((type === 2 || type === 4) && (!st || st.closed)) return;
      sock.send(out);
    });
    return tx;
  };
  const open = () => {
    if (closed) return;
    if (cur) throw Error();
    const st = {
      in: 4 * 1024 * 1024,
      out: 4 * 1024 * 1024,
      wake: null,
      closed: false,
      proxy: null,
      pItems: 0,
      pBytes: 0,
    };
    st.proxy = mkStream({
      secret,
      budget,
      emit: (b) => emitDn(st, b),
      onClose: () => {
        if (!closed && !st.closed) end(true);
      },
    });
    cur = st;
  };
  const write = (data) => {
    if (closed || cur?.closed) return;
    const st = cur;
    if (!st || st.closed) throw Error();
    const n = data.byteLength;
    if (n > st.in) throw Error();
    if (st.pItems >= CFG.laneItems) {
      throw Error();
    }
    budget.reserve(n, 1);
    st.in -= n;
    st.pItems++;
    st.pBytes += n;
    st.proxy
      .push(data)
      .then(
        (accepted) => {
          freeUp(st, n);
          if (closed || st.closed || accepted === false) return;
          st.in += n;
          const delta = new Uint8Array(4);
          new DataView(delta.buffer).setUint32(0, n);
          send(4, delta).catch(() => close());
        },
        () => {
          freeUp(st, n);
          if (!closed && !st.closed) st.proxy.close();
        },
      )
      .catch(() => close());
  };
  const freeUp = (st, n) => {
    if (st.closed) return;
    st.pItems--;
    st.pBytes -= n;
    budget.release(n, 1);
  };
  const emitDn = async (st, b) => {
    onActivity();
    clearTimeout(openTimer);
    for (let o = 0; o < b.byteLength;) {
      while (!closed && !st.closed && st.out === 0) {
        await new Promise((ok) => {
          st.wake = ok;
        });
      }
      if (closed || st.closed) throw Error();
      const n = Math.min(64 * 1024, b.byteLength - o, st.out);
      st.out -= n;
      await send(2, b.subarray(o, o + n));
      o += n;
    }
  };
  const grant = (n) => {
    if (closed || cur?.closed) return;
    const st = cur;
    if (!st || st.closed) throw Error();
    if (n > 4 * 1024 * 1024 - st.out) throw Error();
    st.out += n;
    wake(st);
  };
  const stop = (st) => {
    st.closed = true;
    budget.release(st.pBytes, st.pItems);
    st.pBytes = st.pItems = 0;
    wake(st);
    st.proxy.close();
  };
  const end = (notify) => {
    if (closed || cur?.closed) return;
    const st = cur;
    if (!st) throw Error();
    stop(st);
    if (notify)
      send(3).then(
        () => close(),
        () => close(),
      );
    else close();
  };
  const close = (code = 1000, reason = "") => {
    if (closed) return;
    closed = true;
    clearTimeout(openTimer);
    if (cur) stop(cur);
    cur = null;
    try {
      sock?.close(code, reason);
    } catch {}
    onClose?.();
    onClose = null;
  };
  return { attach, close };
};
function mkPage(host, boot) {
  const nonce = b64(rand(18));
  const body = `<script nonce="__NONCE__">
(()=>{'use strict'; const origin=__ORIGIN__,boot=__BOOTSTRAP__;
const aNonce=/^#android=([A-Za-z0-9_-]{43})$/.exec(location.hash)?.[1]??''; history.replaceState(null,'',location.pathname);
let init=false,closed=false,port=null,token='',started=false,delSent=false,refreshJob=null,refreshTimer=0; let qBytes=0,qItems=0;
const lanes=new Map(),used=new Set(),qMax=33554432,iMax=16384,msgMax=2097152; const laneMax=8388608,laneItems=1024;
const state=st=>port&&!closed&&port.postMessage({t:'status',state:st});
const opts=(method,token,body,keepalive)=>({ method,body,keepalive:!!keepalive,mode:'same-origin',credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer', headers:{...(token&&{Authorization:'Bearer '+token}),...(body&&{'Content-Type':'application/octet-stream'})} });
function check(v){ if(!(v instanceof ArrayBuffer)||!v.byteLength||v.byteLength>msgMax)throw Error(); const view=new DataView(v);let o=0,frames=0; while(o<v.byteLength){ if(v.byteLength-o<8||frames++>=4096)throw Error(); const type=view.getUint8(o),n=view.getUint32(o+4),end=o+8+n; if(n>1048576||end>v.byteLength||(type===2&&!n))throw Error(); o=end; } return v; }
function split(v){ check(v);const view=new DataView(v),out=[];let o=0; while(o<v.byteLength){ const end=o+8+view.getUint32(o+4); out.push(o===0&&end===v.byteLength?v:v.slice(o,end));o=end; } return out; }
function sid(v){const b=new Uint8Array(v);return (b[1]<<16)|(b[2]<<8)|b[3];}
function hold(lane,v){ let buffered=0;for(const {ws} of lanes.values())buffered+=ws?.bufferedAmount??0; const own=lane.ws?.bufferedAmount??0; if(qBytes+buffered>qMax-v.byteLength||qItems>=iMax ||lane.bytes+own>laneMax-v.byteLength||lane.items>=laneItems)return false; qBytes+=v.byteLength;qItems++;lane.bytes+=v.byteLength;lane.items++;return true; }
function free(lane,v){qBytes-=v.byteLength;qItems--;lane.bytes-=v.byteLength;lane.items--;}
function fail(){ if(closed)return;state('failed');port?.postMessage({t:'close'});close(true); }
function drop(){ if(delSent||!token)return;delSent=true; fetch(origin+'/api/v1/session',opts('DELETE',token,null,true)).catch(()=>{}); }
function pump(lane){ const ws=lane.ws; if(closed||lane.done||!ws||ws.readyState!==WebSocket.OPEN||!lane.pending.length)return; if(ws.bufferedAmount>=msgMax){lane.timer ||= setTimeout(()=>{lane.timer=0;pump(lane);},10);return;} try{ const v=lane.pending.shift();ws.send(v);free(lane,v); port.postMessage({t:'traffic',up:v.byteLength,down:0}); if(lane.pending.length)queueMicrotask(()=>pump(lane)); }catch{fail();} }
function push(v){ try{for(const frame of split(v))pushLane(frame);} catch{fail();} }
function end(lane,notify){ if(lane.done)return;lane.done=true;if(lane.timer)clearTimeout(lane.timer); qBytes-=lane.bytes;qItems-=lane.items;lane.bytes=lane.items=0;lane.pending.length=0;lanes.delete(lane.id); try{lane.ws?.close();}catch{} if(notify&&port&&!closed){const frame=new ArrayBuffer(8),b=new Uint8Array(frame);b[0]=3;b[1]=lane.id>>>16;b[2]=lane.id>>>8;b[3]=lane.id;port.postMessage(frame,[frame]);} }
async function open(lane){ if(lane.opening||lane.done)return;lane.opening=true;try{await ensureToken();if(closed||lane.done)return; const target=origin.replace(/^https:/,'wss:')+'/api/v1/ws'; const ws=lane.ws=new WebSocket(target,'tproxy-lane-v1.'+token+'.'+lane.id);ws.binaryType='arraybuffer'; ws.onopen=()=>{if(closed||lane.done){ws.close();return;}lane.opened=true;state('connected');pump(lane);}; ws.onmessage=e=>{ if(closed||lane.done)return; try{ const frames=split(e.data); if(frames.some(frame=>sid(frame)!==lane.id))throw Error(); const ended=frames.some(frame=>new Uint8Array(frame)[0]===3); if(ended)lane.rClosed=true; port.postMessage({t:'traffic',up:0,down:e.data.byteLength});port.postMessage(e.data,[e.data]);state('connected'); if(ended)end(lane,false); }catch{fail();} }; ws.onerror=()=>{}; ws.onclose=()=>{if(closed||lane.done)return;if(!lane.opened){fail();return;}end(lane,!lane.lClosed&&!lane.rClosed);}; }catch{if(!closed&&!lane.done)fail();} }
function rejectLane(id){const frame=new ArrayBuffer(8),b=new Uint8Array(frame);b[0]=3;b[1]=id>>>16;b[2]=id>>>8;b[3]=id;port.postMessage(frame,[frame]);}
function pushLane(v){ const id=sid(v),type=new Uint8Array(v)[0];let lane=lanes.get(id); if(!id)throw Error(); if(!lane&&(type===2||type===3||type===4))return; if(!lane){ if(type!==1||used.has(id)||used.size>=4096)throw Error(); if(lanes.size>=__MAX_LANES__){used.add(id);rejectLane(id);return;} used.add(id);lane={id,ws:null,pending:[],bytes:0,items:0,timer:0,opened:false,done:false,lClosed:false,rClosed:false};lanes.set(id,lane); } if(lane.lClosed)return; if(type===3&&!lane.opened){end(lane,false);return;} if(!hold(lane,v))throw Error(); lane.pending.push(v);if(type===3)lane.lClosed=true; if(token){if(!lane.ws)open(lane);else pump(lane);} }
async function create(first){ try{ state('connecting'); const res=await fetch(origin+'/api/v1/session',opts('POST',boot,first)); if(res.status!==200||res.headers.get('X-Carrier-Mode')!=='websocket-lanes')throw Error(); token=res.headers.get('X-Session-Token')??''; if(!token)throw Error(); const welcome=await res.arrayBuffer();check(welcome); if(closed){drop();return;} port.postMessage(welcome,[welcome]);state('connected');scheduleRefresh(); for(const lane of lanes.values())if(!lane.ws)open(lane); }catch{fail();} }
function tokenExpiry(){try{const raw=atob(token.replace(/-/g,'+').replace(/_/g,'/')+'=');return new DataView(Uint8Array.from(raw,c=>c.charCodeAt(0)).buffer).getUint32(0)*1000;}catch{return 0;}}
async function ensureToken(force=false){if(closed||!token)throw Error();if(!force&&tokenExpiry()-Date.now()>300000)return;if(refreshJob)return refreshJob;refreshJob=(async()=>{const res=await fetch(origin+'/api/v1/session',opts('PUT',token));if(res.status!==200)throw Error();const next=res.headers.get('X-Session-Token');if(!next)throw Error();if(!closed)token=next;})().finally(()=>{refreshJob=null;});return refreshJob;}
function scheduleRefresh(delay=300000){clearTimeout(refreshTimer);if(closed)return;refreshTimer=setTimeout(async()=>{try{await ensureToken(true);scheduleRefresh();}catch{if(!closed){if(tokenExpiry()<=Date.now())fail();else scheduleRefresh(15000);}}},delay);}
function close(notify){ if(closed)return;closed=true;clearTimeout(refreshTimer); for(const lane of [...lanes.values()])end(lane,false);used.clear(); if(notify)drop(); port?.close(); }
function start(next){ init=true;port=next; port.onmessage=msg=>{ const data=msg.data; if(data instanceof ArrayBuffer){ if(!started){ try{check(data);}catch{fail();return;} started=true;create(data); }else push(data); }else if(data&&data.t==='close')close(true); }; port.start();state('connecting'); }
addEventListener('message',e=>{ if(init||e.source!==parent||e.data===null||typeof e.data!=='object')return; const keys=Object.keys(e.data).sort(); if(keys.length!==2||keys[0]!=='t'||keys[1]!=='v'||e.data.t!=='tproxy-init'||e.data.v!==1||e.ports.length!==1)return; let src;try{src=new URL(e.origin);}catch{return;} if(src.protocol!=='http:'||src.hostname!=='127.0.0.1'||!src.port||src.origin!==e.origin)return; start(e.ports[0]); }); const android=globalThis.TelegramWebProxy;
if(!init&&aNonce&&android&&typeof android.postMessage==='function'){ const aPort={onmessage:null,start(){},close(){android.onmessage=null;},postMessage(v){ if(v instanceof ArrayBuffer){for(const frame of split(v))android.postMessage(frame);} else android.postMessage(JSON.stringify(v)); }}; android.onmessage=e=>{ let data=e.data;if(typeof data==='string'){try{data=JSON.parse(data);}catch{return;}} aPort.onmessage?.({data}); }; start(aPort);android.postMessage(JSON.stringify({t:'tproxy-android-init',v:1,nonce:aNonce})); } addEventListener('pagehide',()=>close(true),{once:true}); })();
</script>`
    .replaceAll("__NONCE__", nonce)
    .replace("__MAX_LANES__", String(CFG.maxLanes))
    .replace("__ORIGIN__", JSON.stringify(`https://${host}`))
    .replace("__BOOTSTRAP__", JSON.stringify(String(boot)));
  const csp = [
    "default-src 'none'",
    "base-uri 'none'",
    "child-src 'none'",
    `connect-src 'self' wss://${host}`,
    "font-src 'none'",
    "form-action 'none'",
    "frame-ancestors http://127.0.0.1:*",
    "frame-src 'none'",
    "img-src 'none'",
    "manifest-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'none'",
    "worker-src 'none'",
    "sandbox allow-same-origin allow-scripts",
  ].join("; ");
  return { body, csp };
}

// Stateful coordination lives in exactly one object per hostname/SECRET pair.
// Normal WebSockets are intentional: live KWS sockets and CTR state cannot
// survive hibernation. Durable storage preserves stream IDs and revocation.
export class ProxyCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.records = new Map();
    this.dirty = new Set();
    this.removed = new Set();
    this.budget = mkBudget();
    this.serial = Promise.resolve();
    this.nextAlarm = 0;
    this.ready = state.blockConcurrencyWhile(async () => {
      const ids = (await state.storage.get("recordIds")) || [];
      const rows = await Promise.all(
        ids.map((id) => state.storage.get(`record:${id}`)),
      );
      for (const row of rows)
        if (row)
          this.records.set(row.id, {
            ...row,
            used: new Set(row.used),
            handles: new Map(),
          });
    });
  }
  async fetch(req) {
    // Never hold the shared mutation lock while receiving a client body.
    if (
      req.method === "POST" &&
      new URL(req.url).pathname === "/api/v1/session"
    ) {
      const cfg = mkCfg(this.env),
        token = bearer(req.headers.get("Authorization"));
      if (!binary(req) || !(await verify(token, cfg.boot, "bootstrap")))
        return reply();
      try {
        const body = await readBounded(req, 9);
        hello(body);
        req = new Request(req, { body });
      } catch {
        return reply();
      }
    }
    const result = this.serial.then(() => this.handle(req));
    this.serial = result.catch(() => {});
    return result;
  }
  async persist() {
    const ids = [...this.records.keys()];
    const dirty = [...this.dirty];
    const removed = [...this.removed];
    const rows = dirty
      .map((id) => this.records.get(id))
      .filter(Boolean)
      .map(({ id, token, expires, keepUntil, used, deleted }) => ({
        id,
        token,
        expires,
        keepUntil,
        used: [...used],
        deleted,
      }));
    this.dirty.clear();
    this.removed.clear();
    try {
      for (const row of rows)
        await this.state.storage.put(`record:${row.id}`, row);
      await this.state.storage.put("recordIds", ids);
      for (const id of removed) await this.state.storage.delete(`record:${id}`);
    } catch (error) {
      for (const id of dirty) this.dirty.add(id);
      for (const id of removed) this.removed.add(id);
      throw error;
    }
    if (ids.length && !this.nextAlarm) {
      this.nextAlarm = Date.now() + CFG.renewMs;
      await this.state.storage.setAlarm(this.nextAlarm);
    } else if (!ids.length) {
      this.nextAlarm = 0;
      await this.state.storage.deleteAlarm();
    }
  }
  revoke(record) {
    record.deleted = true;
    record.used.clear();
    this.dirty.add(record.id);
    record.expires = Math.max(record.keepUntil, Date.now() + 2 * 60 * 1000);
    for (const lane of [...record.handles.values()]) lane.close();
    record.handles.clear();
  }
  reap() {
    const now = Date.now();
    for (const [id, record] of this.records) {
      if (!record.deleted && record.expires <= now) this.revoke(record);
      if (record.deleted && record.expires <= now) {
        this.records.delete(id);
        this.dirty.delete(id);
        this.removed.add(id);
      }
    }
  }
  async alarm() {
    const result = this.serial.then(async () => {
      await this.ready;
      this.nextAlarm = 0;
      this.reap();
      await this.persist();
    });
    this.serial = result.catch(() => {});
    return result;
  }
  async handle(req) {
    await this.ready;
    const cfg = mkCfg(this.env),
      url = new URL(req.url),
      method = req.method;
    this.reap();
    if (!originAllowed(req, url)) return reply();
    if (url.pathname === "/api/v1/session") {
      const token = bearer(req.headers.get("Authorization"));
      if (method === "POST") {
        if (!binary(req) || !(await verify(token, cfg.boot, "bootstrap")))
          return reply();
        try {
          hello(await readBounded(req, 9));
        } catch {
          return reply();
        }
        const id = tokenId(token);
        let record = this.records.get(id);
        if (record?.deleted) return reply(null, 409);
        if (!record) {
          const live = [...this.records.values()].filter(
            (v) => !v.deleted,
          ).length;
          if (live >= CFG.maxSessions || this.records.size >= CFG.maxRecords)
            return new Response(null, {
              status: 503,
              headers: { "Retry-After": "30" },
            });
          const expires = Date.now() + CFG.tokenMs;
          record = {
            id,
            token: await mkToken(
              cfg.boot,
              "session",
              expires,
              un64(token).slice(4, 16),
            ),
            expires: Date.now() + CFG.idleMs,
            keepUntil: Math.ceil(expires / 1000) * 1000,
            used: new Set(),
            handles: new Map(),
            deleted: false,
          };
          this.records.set(id, record);
          this.dirty.add(id);
        }
        await this.persist();
        return welcome(record.token);
      }
      if (method !== "PUT" && method !== "DELETE") return reply();
      // Expired signatures are permitted only for stateful renewal/revocation;
      // the matching live record must still exist and be within its idle lease.
      if (!(await verify(token, cfg.boot, "session", true))) return reply();
      const record = this.records.get(tokenId(token));
      if (!record) return reply();
      if (method === "DELETE") {
        if (!record.deleted) this.revoke(record);
        await this.persist();
        return reply(null, 204);
      }
      if (record.deleted) return reply(null, 409);
      const expires = Date.now() + CFG.tokenMs;
      record.token = await mkToken(
        cfg.boot,
        "session",
        expires,
        un64(token).slice(4, 16),
      );
      record.keepUntil = Math.max(
        record.keepUntil,
        Math.ceil(expires / 1000) * 1000,
      );
      record.expires = Date.now() + CFG.idleMs;
      this.dirty.add(record.id);
      await this.persist();
      return welcome(record.token);
    }
    if (
      url.pathname !== "/api/v1/ws" ||
      method !== "GET" ||
      req.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    )
      return reply();
    const lane = await laneAuth(req, cfg.boot);
    if (!lane) return reply();
    const { token, sid, proto } = lane,
      record = this.records.get(tokenId(token));
    // A valid signature never creates new state on the lane or DELETE paths.
    if (!record) return reply();
    if (
      record.deleted ||
      record.used.has(sid) ||
      record.handles.size >= CFG.maxLanes ||
      record.used.size >= CFG.maxUsed
    )
      return reply(null, 409);
    record.used.add(sid);
    this.dirty.add(record.id);
    record.expires = Date.now() + CFG.idleMs;
    await this.persist();
    const { 0: client, 1: server } = new WebSocketPair();
    const sess = mkSession({
      secret: cfg.key,
      sid,
      lease: record,
      budget: this.budget,
      onActivity: () => {
        if (!record.deleted) {
          record.expires = Date.now() + CFG.idleMs;
          this.dirty.add(record.id);
        }
      },
      onClose: () => {
        record.handles.delete(sid);
      },
    });
    record.handles.set(sid, sess);
    try {
      sess.attach(server);
    } catch {
      sess.close();
      return reply(null, 409);
    }
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": proto },
    });
  }
}
const tokenId = (token) => b64(un64(token).slice(4, 16));
const welcome = (token) =>
  new Response(enc(0x11, 0), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Session-Token": token,
      "X-Carrier-Mode": "websocket-lanes",
    },
  });
async function readBounded(req, size) {
  if (!req.body) throw Error();
  const reader = req.body.getReader(),
    out = new Uint8Array(size);
  let n = 0;
  let timer;
  const consume = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (n + value.byteLength > size) throw Error();
      out.set(value, n);
      n += value.byteLength;
    }
    if (n !== size) throw Error();
    return out;
  })();
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error("body timeout")), 5000);
  });
  try {
    return await Promise.race([consume, deadline]);
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function laneAuth(req, boot) {
  const offers = protos(req),
    proto = offers.length === 1 ? offers[0] : null;
  const parts = proto?.split(".") || [],
    [kind, token = "", id] = parts,
    sid = Number(id);
  if (
    parts.length !== 3 ||
    kind !== "tproxy-lane-v1" ||
    !/^[1-9][0-9]{0,7}$/.test(id) ||
    sid > 0xffffff ||
    !(await verify(token, boot, "session"))
  )
    return null;
  return { proto, token, sid };
}
const route = async (req, env) => {
  const url = new URL(req.url),
    { pathname: path } = url,
    { method, headers } = req;
  let cfg;
  try {
    cfg = mkCfg(env);
    if (!env.SESSIONS) throw Error();
  } catch {
    return ["/", "/health", "/api/v1/session", "/api/v1/ws"].includes(path)
      ? reply(null, 500)
      : reply();
  }
  if (path === "/health" && method === "GET")
    return new Response('{"ok":true,"variant":"personal-fixed"}', {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  if (path === "/" && (method === "GET" || method === "HEAD")) {
    let host;
    if (method === "GET") {
      try {
        host = await bridge(url, cfg.secret);
      } catch {}
    }
    if (!host)
      return new Response(
        method === "HEAD"
          ? null
          : '<!doctype html><meta charset="utf-8"><title>Connection</title>',
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    const page = mkPage(host, await mkBoot(cfg.boot));
    return new Response(page.body, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": page.csp,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Permissions-Policy":
          "camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=()",
      },
    });
  }
  if (!originAllowed(req, url)) return reply();
  if (path === "/api/v1/session") {
    const token = bearer(headers.get("Authorization"));
    if (method === "POST") {
      if (!binary(req) || !(await verify(token, cfg.boot, "bootstrap")))
        return reply();
    } else if (method === "PUT" || method === "DELETE") {
      if (!(await verify(token, cfg.boot, "session", true))) return reply();
    } else return reply();
  } else if (path === "/api/v1/ws") {
    if (
      method !== "GET" ||
      headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
      !(await laneAuth(req, cfg.boot))
    )
      return reply();
  } else return reply();
  const key = await mkCap(cfg.secret, url.hostname);
  const id = env.SESSIONS.idFromName(`personal-v1:${url.hostname}:${key}`);
  return env.SESSIONS.get(id).fetch(req);
};
