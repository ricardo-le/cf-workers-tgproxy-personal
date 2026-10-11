const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");
const { webcrypto, createCipheriv, createHash } = require("node:crypto");
const path = require("node:path");
const sourceFile =
  process.env.PROXY_SOURCE || path.join(__dirname, "../telegram_webproxy.js");
const source = fs
  .readFileSync(sourceFile, "utf8")
  .replace(/export default \{[\s\S]*?\};/, "")
  .replace("export class ProxyCoordinator", "class ProxyCoordinator");
class Socket {
  constructor() {
    this.listeners = {};
    this.sent = [];
    this.closeCalls = 0;
    this.protocol = "binary";
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  dispatch(type, event = {}) {
    for (const fn of this.listeners[type] || []) fn(event);
  }
  accept() {}
  send(data) {
    this.sent.push(new Uint8Array(data).slice());
  }
  close() {
    this.closeCalls++;
  }
}
class WorkerResponse {
  constructor(body, options = {}) {
    this.body = body;
    this.status = options.status || 200;
    this.headers = new Headers(options.headers);
    this.webSocket = options.webSocket;
  }
  async arrayBuffer() {
    return typeof this.body === "string"
      ? new TextEncoder().encode(this.body).buffer
      : new Uint8Array(this.body || []).slice().buffer;
  }
}
function harness(namespace) {
  const clock = { now: 1800000000000 };
  class Clock extends Date {
    static now() {
      return clock.now;
    }
  }
  const pairs = [];
  const outbound = [];
  class Upstream extends Socket {
    constructor(url, protocol) {
      super();
      this.url = url;
      this.protocol = protocol;
      outbound.push(this);
      queueMicrotask(() => this.dispatch("open"));
    }
  }
  class Pair {
    constructor() {
      this[0] = new Socket();
      this[1] = new Socket();
      pairs.push(this);
    }
  }
  const context = vm.createContext({
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    DataView,
    URL,
    Headers,
    Request,
    Response: WorkerResponse,
    WebSocketPair: Pair,
    WebSocket: Upstream,
    AbortController,
    Date: Clock,
    btoa,
    atob,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    console,
  });
  vm.runInContext(source, context);
  const api = vm.runInContext(
    '({route,mkBoot,mkToken,mkCap,mkCtr,mkWire,mkPkt,mkPage,mkStream,cipher,mkHead,headOf,wireHead,getKey,enc,CFG, ProxyCoordinator:typeof ProxyCoordinator === "function" ? ProxyCoordinator : null, mkBudget:typeof mkBudget === "function" ? mkBudget : null})',
    context,
  );
  const env = {
    SECRET: "000102030405060708090a0b0c0d0e0f",
    BOOT: "audit-only-bootstrap-key-that-is-long",
  };
  const objects = namespace || new Map();
  const pending = [];
  env.SESSIONS = {
    idFromName(name) {
      return name;
    },
    get(name) {
      if (!objects.has(name)) {
        assert.equal(
          typeof api.ProxyCoordinator,
          "function",
          "Durable Object coordinator must exist",
        );
        const values = new Map();
        const storage = {
          async get(k) {
            return structuredClone(values.get(k));
          },
          async put(k, v) {
            values.set(k, structuredClone(v));
          },
          async delete(k) {
            return values.delete(k);
          },
          async setAlarm(at) {
            values.set("alarm", at);
          },
          async deleteAlarm() {
            values.delete("alarm");
          },
        };
        const state = {
          storage,
          blockConcurrencyWhile(fn) {
            return fn();
          },
          waitUntil(p) {
            pending.push(p);
          },
        };
        const object = new api.ProxyCoordinator(state, env);
        objects.set(name, { object, storage, values, state });
      }
      return objects.get(name).object;
    },
  };
  return { api, env, clock, pairs, outbound, objects, pending, context };
}
const wsRequest = (token, sid) =>
  new Request("https://proxy.example.com/api/v1/ws", {
    headers: {
      Upgrade: "websocket",
      Origin: "https://proxy.example.com",
      "Sec-WebSocket-Protocol": `tproxy-lane-v1.${token}.${sid}`,
    },
  });
const hello = new Uint8Array([16, 0, 0, 0, 0, 0, 0, 1, 1]);
const controlRequest = (method, token, body) =>
  new Request("https://proxy.example.com/api/v1/session", {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body && { "Content-Type": "application/octet-stream" }),
    },
    body,
  });
async function session(h) {
  const bootstrap = await h.api.mkBoot(h.env.BOOT);
  const response = await h.api.route(
    controlRequest("POST", bootstrap, hello),
    h.env,
  );
  assert.equal(response.status, 200);
  return { bootstrap, token: response.headers.get("X-Session-Token") };
}
test("bridge HMAC matches both official vectors", async () => {
  const h = harness();
  assert.equal(
    await h.api.mkCap(h.env.SECRET, "proxy.example.com"),
    "MHLEY5PmW1GWqJkSrlmJpvJUiLhBH_QKy6yKg8a0JPk",
  );
  assert.equal(
    await h.api.mkCap("dd" + h.env.SECRET, "proxy.example.com"),
    "IpJrt3e7sKtzPyoXy6w-Zj6GGEvsvclN66JzQEfPYLA",
  );
});
test("fragmented AES matches native AES for 24 cases", async () => {
  const h = harness();
  for (let trial = 0; trial < 24; trial++) {
    const key = webcrypto.getRandomValues(new Uint8Array(32)),
      iv = webcrypto.getRandomValues(new Uint8Array(16));
    const plain = webcrypto.getRandomValues(new Uint8Array(4096 + trial)),
      native = createCipheriv("aes-256-ctr", key, iv);
    const expected = Buffer.concat([native.update(plain), native.final()]),
      actual = [],
      ctr = h.api.mkCtr(key, iv);
    for (let o = 0; o < plain.length;) {
      const n = 1 + webcrypto.getRandomValues(new Uint8Array(1))[0];
      actual.push(Buffer.from(await ctr.crypt(plain.subarray(o, o + n))));
      o += n;
    }
    assert.deepEqual(Buffer.concat(actual), expected);
  }
});
test("bootstrap retries return the same session token", async () => {
  const h = harness(),
    s = await session(h),
    r = await h.api.route(controlRequest("POST", s.bootstrap, hello), h.env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("X-Session-Token"), s.token);
});
test("raw BOOT is never accepted as bootstrap", async () => {
  const h = harness(),
    r = await h.api.route(controlRequest("POST", h.env.BOOT, hello), h.env);
  assert.equal(r.status, 404);
});
test("ee and ef secrets are rejected before deployment health succeeds", () => {
  const h = harness();
  for (const prefix of ["ee", "ef"])
    assert.throws(() => h.api.getKey(prefix + h.env.SECRET));
});
test("existing sessions can renew and open lanes beyond five minutes", async () => {
  const h = harness(),
    s = await session(h);
  h.clock.now += 301000;
  const r = await h.api.route(controlRequest("PUT", s.token), h.env);
  assert.equal(r.status, 200);
  const renewed = r.headers.get("X-Session-Token");
  assert.ok(renewed);
  assert.notEqual(renewed, s.token);
  assert.equal((await h.api.route(wsRequest(renewed, 1), h.env)).status, 101);
  h.pairs.at(-1)[1].dispatch("close");
});
test("DELETE closes active lanes immediately", async () => {
  const h = harness(),
    s = await session(h);
  assert.equal((await h.api.route(wsRequest(s.token, 1), h.env)).status, 101);
  const server = h.pairs.at(-1)[1];
  assert.equal(
    (await h.api.route(controlRequest("DELETE", s.token), h.env)).status,
    204,
  );
  assert.equal(server.closeCalls, 1);
  assert.equal((await h.api.route(wsRequest(s.token, 2), h.env)).status, 409);
});
test("coordinator enforces stream uniqueness across Worker contexts", async () => {
  const a = harness(),
    s = await session(a);
  assert.equal((await a.api.route(wsRequest(s.token, 1), a.env)).status, 101);
  const b = harness(a.objects);
  assert.equal((await b.api.route(wsRequest(s.token, 1), b.env)).status, 409);
  await a.api.route(controlRequest("DELETE", s.token), a.env);
  assert.equal((await b.api.route(wsRequest(s.token, 2), b.env)).status, 409);
});
test("upstream receive queue closes when lane byte cap is exceeded", async () => {
  const h = harness(),
    peer = new Socket(),
    wire = h.api.mkWire(peer, 7500);
  peer.dispatch("open");
  await wire.ready;
  for (let i = 0; i < 160; i++)
    peer.dispatch("message", { data: new Uint8Array(64 * 1024).buffer });
  assert.ok(peer.closeCalls > 0);
  assert.equal(wire.closed, true);
  wire.close();
});
test("upstream packets remain charged until the consumer releases them", async () => {
  const h = harness(),
    budget = h.api.mkBudget(),
    peer = new Socket(),
    wire = h.api.mkWire(peer, 7500, undefined, budget);
  peer.dispatch("open");
  await wire.ready;
  const pending = wire.readPack();
  await new Promise((resolve) => setImmediate(resolve));
  peer.dispatch("message", { data: new Uint8Array(8 * 1024 * 1024).buffer });
  const held = await pending;
  assert.equal(budget.bytes, held.byteLength);
  wire.close();
  assert.equal(budget.bytes, 0);
  assert.equal(budget.items, 0);
});
test("a slow POST body does not block DELETE for another session", async () => {
  const h = harness(),
    s = await session(h),
    object = [...h.objects.values()][0].object;
  let controller;
  const body = new ReadableStream({
    start(c) {
      controller = c;
      c.enqueue(new Uint8Array([16]));
    },
  });
  const blocked = object.fetch(
    new Request("https://proxy.example.com/api/v1/session", {
      method: "POST",
      headers: controlRequest("POST", s.bootstrap, hello).headers,
      body,
      duplex: "half",
    }),
  );
  try {
    await new Promise((resolve) => setImmediate(resolve));
    const r = await Promise.race([
      h.api.route(controlRequest("DELETE", s.token), h.env),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(Error("slow body blocks unrelated DELETE")),
          200,
        ),
      ),
    ]);
    assert.equal(r.status, 204);
  } finally {
    controller.close();
    await blocked;
  }
});
test("coalesced packets and byte/item overflow release the shared budget", async () => {
  const h = harness(),
    budget = h.api.mkBudget(100, 10),
    peer = new Socket(),
    wire = h.api.mkWire(peer, 7500, undefined, budget);
  peer.dispatch("open");
  await wire.ready;
  for (let i = 0; i < 3; i++)
    peer.dispatch("message", { data: new Uint8Array(10).buffer });
  const packet = await wire.readPack();
  assert.equal(packet.byteLength, 30);
  assert.equal(budget.bytes, 30);
  assert.equal(budget.items, 3);
  wire.releasePack(packet);
  assert.equal(budget.bytes, 0);
  assert.equal(budget.items, 0);
  for (let i = 0; i < 11; i++)
    peer.dispatch("message", { data: new Uint8Array(1).buffer });
  assert.equal(wire.closed, true);
  assert.equal(budget.bytes, 0);
  assert.equal(budget.items, 0);
});
test("parsed upload packets stay charged until encryption and sending finish", () => {
  const h = harness(),
    budget = h.api.mkBudget(),
    parser = h.api.mkPkt(0xef, budget);
  const packet = new Uint8Array([2, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(parser.push(packet.subarray(0, 4)).length, 0);
  assert.equal(budget.bytes, 4);
  const [parsed] = parser.push(packet.subarray(4));
  assert.equal(budget.bytes, 9);
  parser.releasePacket(parsed);
  assert.equal(budget.bytes, 0);
  parser.clear();
  assert.equal(budget.bytes, 0);
});
test("upload parser enforces item caps and frees partial parse failures", () => {
  const h = harness(),
    budget = h.api.mkBudget(102400, 3),
    parser = h.api.mkPkt(0xef, budget);
  const burst = new Uint8Array(20);
  for (let i = 0; i < 4; i++) burst[i * 5] = 1;
  assert.throws(() => parser.push(burst));
  assert.ok(budget.items <= 3);
  parser.clear();
  assert.equal(budget.bytes, 0);
  assert.equal(budget.items, 0);
  const malformed = h.api.mkPkt(0xef, budget);
  assert.throws(() => malformed.push(new Uint8Array([1, 1, 2, 3, 4, 0])));
  malformed.clear();
  assert.equal(budget.bytes, 0);
  assert.equal(budget.items, 0);
});
test("revocation and used stream IDs survive coordinator recreation", async () => {
  const h = harness(),
    s = await session(h);
  await h.api.route(wsRequest(s.token, 7), h.env);
  h.pairs.at(-1)[1].dispatch("close");
  const entry = [...h.objects.values()][0];
  entry.object = new h.api.ProxyCoordinator(entry.state, h.env);
  assert.equal((await h.api.route(wsRequest(s.token, 7), h.env)).status, 409);
  await h.api.route(controlRequest("DELETE", s.token), h.env);
  entry.object = new h.api.ProxyCoordinator(entry.state, h.env);
  assert.equal((await h.api.route(wsRequest(s.token, 8), h.env)).status, 409);
});
test("an expired token can renew an active session, but an idle session cannot renew", async () => {
  const h = harness(),
    s = await session(h);
  await h.api.route(wsRequest(s.token, 1), h.env);
  h.clock.now += 20 * 60 * 1000;
  h.pairs.at(-1)[1].dispatch("message", { data: h.api.enc(1, 1).buffer });
  h.clock.now += 11 * 60 * 1000;
  const renewed = await h.api.route(controlRequest("PUT", s.token), h.env);
  assert.equal(renewed.status, 200);
  await h.api.route(controlRequest("DELETE", s.token), h.env);
  const idle = await session(h);
  h.clock.now += h.api.CFG.idleMs + 1;
  assert.equal(
    (await h.api.route(controlRequest("PUT", idle.token), h.env)).status,
    409,
  );
});
test("session quota is enforced and DELETE frees a live slot", async () => {
  const h = harness(),
    sessions = [];
  for (let i = 0; i < h.api.CFG.maxSessions; i++)
    sessions.push(await session(h));
  const boot = await h.api.mkBoot(h.env.BOOT);
  assert.equal(
    (await h.api.route(controlRequest("POST", boot, hello), h.env)).status,
    503,
  );
  await h.api.route(controlRequest("DELETE", sessions[0].token), h.env);
  assert.equal(
    (await h.api.route(controlRequest("POST", boot, hello), h.env)).status,
    200,
  );
});
test("bridge rejects lane 33 with CLOSE while preserving its 32 existing lanes", async () => {
  const h = harness(),
    messages = [],
    sockets = [],
    events = new Map(),
    timers = new Map();
  let timerId = 0;
  const android = {
    postMessage(v) {
      messages.push(v);
    },
    onmessage: null,
  };
  class BrowserSocket {
    static OPEN = 1;
    constructor(url, protocol) {
      this.protocol = protocol;
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.sent = [];
      this.closed = false;
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(v) {
      this.sent.push(v);
    }
    close() {
      this.closed = true;
      this.readyState = 3;
    }
  }
  const context = vm.createContext({
    TelegramWebProxy: android,
    WebSocket: BrowserSocket,
    ArrayBuffer,
    Uint8Array,
    DataView,
    URL,
    atob,
    JSON,
    Date: vm.runInContext("Date", h.context),
    location: { hash: "#android=" + "a".repeat(43), pathname: "/" },
    history: { replaceState() {} },
    parent: {},
    queueMicrotask,
    addEventListener(type, fn) {
      events.set(type, fn);
    },
    setTimeout(fn, ms) {
      timers.set(++timerId, { fn, ms });
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    fetch: async (url, options) =>
      h.api.route(new Request(url, options), h.env),
  });
  const page = h.api.mkPage(
    "proxy.example.com",
    await h.api.mkBoot(h.env.BOOT),
  );
  vm.runInContext(
    /<script[^>]*>([\s\S]*?)<\/script>/.exec(page.body)[1],
    context,
  );
  android.onmessage({ data: hello.buffer });
  for (
    let i = 0;
    i < 100 && !messages.some((v) => v instanceof ArrayBuffer);
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(
    messages.some((v) => v instanceof ArrayBuffer),
    "bridge welcome arrived",
  );
  for (let sid = 1; sid <= 33; sid++) {
    android.onmessage({ data: h.api.enc(1, sid).buffer });
    await new Promise((resolve) => setImmediate(resolve));
  }
  try {
    assert.equal(sockets.length, 32);
    assert.ok(
      !messages.some(
        (v) => typeof v === "string" && JSON.parse(v).state === "failed",
      ),
    );
    assert.ok(sockets.every((s) => !s.closed));
    assert.ok(
      messages.some(
        (v) =>
          v instanceof ArrayBuffer &&
          new Uint8Array(v)[0] === 3 &&
          new Uint8Array(v)[3] === 33,
      ),
    );
    const old = sockets[0].protocol;
    h.clock.now += 301000;
    await [...timers.values()].find((t) => t.ms === 300000).fn();
    android.onmessage({ data: h.api.enc(3, 32).buffer });
    sockets[31].onclose();
    android.onmessage({ data: h.api.enc(1, 34).buffer });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sockets.length, 33);
    assert.notEqual(sockets.at(-1).protocol.split(".")[1], old.split(".")[1]);
  } finally {
    events.get("pagehide")();
  }
});
for (const mode of [0xef, 0xee, 0xdd])
  test(`two-way transport conversion preserves bytes for mode ${mode.toString(16)}`, async () => {
    const h = harness(),
      budget = h.api.mkBudget(),
      received = [],
      secretBytes = Buffer.from(h.env.SECRET, "hex");
    const nativeCipher = (head, secret, reverse) => {
      let material = Buffer.from(head.subarray(8, 56));
      if (reverse) material.reverse();
      const key = secret.length
        ? createHash("sha256")
            .update(material.subarray(0, 32))
            .update(secret)
            .digest()
        : material.subarray(0, 32);
      return createCipheriv("aes-256-ctr", key, material.subarray(32, 48));
    };
    const head = h.api.mkHead(mode, 2, true),
      clientUp = nativeCipher(head, secretBytes, false),
      clientDown = nativeCipher(head, secretBytes, true);
    const wireHeader = clientUp.update(head);
    wireHeader.set(head.subarray(0, 56));
    const payload = Buffer.from([
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8,
        ...(mode === 0xdd ? [9] : []),
      ]),
      prefix = Buffer.alloc(mode === 0xef ? 1 : 4);
    if (mode === 0xef) prefix[0] = payload.length / 4;
    else prefix.writeUInt32LE(payload.length);
    const plain = Buffer.concat([prefix, payload]),
      encrypted = clientUp.update(plain);
    let closeCount = 0;
    const stream = h.api.mkStream({
      secret: secretBytes,
      budget,
      emit: async (b) => received.push(Buffer.from(b)),
      onClose: () => closeCount++,
    });
    try {
      await stream.push(new Uint8Array(wireHeader.subarray(0, 23)));
      await stream.push(new Uint8Array(wireHeader.subarray(23)));
      const peer = h.outbound[0];
      assert.equal(peer.url, "wss://kws3-1.web.telegram.org/apiws");
      const kwsHead = peer.sent[0],
        kwsReceive = nativeCipher(kwsHead, Buffer.alloc(0), false);
      const decodedHead = kwsReceive.update(kwsHead);
      assert.equal(decodedHead[56], mode);
      assert.equal(decodedHead.readInt16LE(60), -3);
      await stream.push(new Uint8Array(encrypted.subarray(0, 2)));
      await stream.push(new Uint8Array(encrypted.subarray(2)));
      assert.deepEqual(
        Buffer.concat(peer.sent.slice(1).map((b) => kwsReceive.update(b))),
        plain,
      );
      const down = webcrypto.getRandomValues(new Uint8Array(32768 + 19)),
        kwsSend = nativeCipher(kwsHead, Buffer.alloc(0), true),
        downWire = kwsSend.update(down);
      peer.dispatch("message", { data: downWire.subarray(0, 13) });
      peer.dispatch("message", { data: downWire.subarray(13) });
      for (
        let i = 0;
        i < 200 && received.reduce((n, b) => n + b.length, 0) < down.length;
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 1));
      assert.deepEqual(
        clientDown.update(Buffer.concat(received)),
        Buffer.from(down),
      );
    } finally {
      stream.close();
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(closeCount, 1);
    assert.equal(budget.bytes, 0);
    assert.equal(budget.items, 0);
  });
