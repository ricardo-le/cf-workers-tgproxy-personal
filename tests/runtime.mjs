import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
const secret = "000102030405060708090a0b0c0d0e0f",
  boot = "test-runtime-bootstrap-secret-32-bytes";
const host = "proxy.example.com";
const cap = createHmac("sha256", Buffer.from(secret, "hex"))
  .update(`tdesktop-web-proxy-bridge-v1\n${host}`)
  .digest("base64url");
const hello = new Uint8Array([16, 0, 0, 0, 0, 0, 0, 1, 1]);
const url = (path) => `https://${host}${path}`;
const control = (method, token, body) => ({
  method,
  headers: {
    Authorization: `Bearer ${token}`,
    ...(body && { "Content-Type": "application/octet-stream" }),
  },
  body,
});
const lane = (token, sid) => ({
  headers: {
    Upgrade: "websocket",
    Origin: `https://${host}`,
    "Sec-WebSocket-Protocol": `tproxy-lane-v1.${token}.${sid}`,
  },
});
test("workerd: full bridge/session/lane/delete contract with a real SQLite Durable Object", async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: fileURLToPath(
        new URL("../telegram_webproxy.js", import.meta.url),
      ),
      compatibilityDate: "2026-10-06",
      bindings: { SECRET: secret, BOOT: boot },
      durableObjects: {
        SESSIONS: { className: "ProxyCoordinator", useSQLite: true },
      },
    }),
  );
  try {
    const health = await mf.dispatchFetch(url("/health"));
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
    const page = await mf.dispatchFetch(url("/?bridge=" + cap));
    assert.equal(page.status, 200);
    assert.match(
      page.headers.get("Content-Security-Policy"),
      /frame-ancestors http:\/\/127\.0\.0\.1:\*/,
    );
    const html = await page.text(),
      bootstrap = /boot="([A-Za-z0-9_-]{43})"/.exec(html)?.[1];
    assert.ok(bootstrap, "bridge exposes only signed bootstrap");
    assert.ok(!html.includes(boot));
    assert.match(html, /ensureToken/);
    const wrongOrigin = await mf.dispatchFetch(url("/api/v1/session"), {
      ...control("POST", bootstrap, hello),
      headers: {
        ...control("POST", bootstrap, hello).headers,
        Origin: "https://other.example.com",
      },
    });
    assert.equal(wrongOrigin.status, 404);
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        mf.dispatchFetch(
          url("/api/v1/session"),
          control("POST", bootstrap, hello),
        ),
      ),
    );
    const tokens = responses.map((r) => r.headers.get("X-Session-Token"));
    assert.ok(responses.every((r) => r.status === 200));
    assert.equal(new Set(tokens).size, 1);
    assert.deepEqual(
      [...new Uint8Array(await responses[0].arrayBuffer())],
      [17, 0, 0, 0, 0, 0, 0, 0],
    );
    const token = tokens[0],
      wsResponse = await mf.dispatchFetch(url("/api/v1/ws"), lane(token, 7));
    assert.equal(wsResponse.status, 101);
    assert.equal(
      wsResponse.headers.get("Sec-WebSocket-Protocol"),
      `tproxy-lane-v1.${token}.7`,
    );
    const socket = wsResponse.webSocket;
    socket.accept();
    assert.equal(
      (await mf.dispatchFetch(url("/api/v1/ws"), lane(token, 7))).status,
      409,
    );
    const renewed = await mf.dispatchFetch(
      url("/api/v1/session"),
      control("PUT", token),
    );
    assert.equal(renewed.status, 200);
    assert.ok(renewed.headers.get("X-Session-Token"));
    const closed = new Promise((resolve) =>
      socket.addEventListener("close", resolve, { once: true }),
    );
    const deleted = await mf.dispatchFetch(
      url("/api/v1/session"),
      control("DELETE", token),
    );
    assert.equal(deleted.status, 204);
    await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(Error("DELETE did not close lane")), 2000),
      ),
    ]);
    assert.equal(
      (await mf.dispatchFetch(url("/api/v1/ws"), lane(token, 8))).status,
      409,
    );
    assert.equal(
      (
        await mf.dispatchFetch(
          url("/api/v1/session"),
          control("POST", bootstrap, hello),
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await mf.dispatchFetch(
          url("/api/v1/session"),
          control("POST", boot, hello),
        )
      ).status,
      404,
    );
  } finally {
    await mf.dispose();
  }
});

test("workerd: authenticated opaque-origin WebKit clients can create, renew, open and delete", async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: fileURLToPath(
        new URL("../telegram_webproxy.js", import.meta.url),
      ),
      compatibilityDate: "2026-10-06",
      bindings: { SECRET: secret, BOOT: boot },
      durableObjects: {
        SESSIONS: { className: "ProxyCoordinator", useSQLite: true },
      },
    }),
  );
  let socket;
  try {
    const page = await mf.dispatchFetch(url("/?bridge=" + cap));
    const bootstrap = /boot="([A-Za-z0-9_-]{43})"/.exec(await page.text())?.[1];
    assert.ok(bootstrap);
    const opaque = (method, token, body) => {
      const options = control(method, token, body);
      options.headers.Origin = "null";
      return options;
    };
    assert.equal(
      (
        await mf.dispatchFetch(
          url("/api/v1/session"),
          opaque("POST", "invalid", hello),
        )
      ).status,
      404,
    );
    const response = await mf.dispatchFetch(
      url("/api/v1/session"),
      opaque("POST", bootstrap, hello),
    );
    assert.equal(
      response.status,
      200,
      "valid HELLO from a sandboxed WebKit client must receive WELCOME",
    );
    const token = response.headers.get("X-Session-Token");
    assert.ok(token);
    assert.deepEqual(
      [...new Uint8Array(await response.arrayBuffer())],
      [17, 0, 0, 0, 0, 0, 0, 0],
    );
    assert.equal(
      (await mf.dispatchFetch(url("/api/v1/session"), opaque("PUT", "invalid")))
        .status,
      404,
    );
    assert.equal(
      (
        await mf.dispatchFetch(
          url("/api/v1/session"),
          opaque("DELETE", "invalid"),
        )
      ).status,
      404,
    );
    const renewed = await mf.dispatchFetch(
      url("/api/v1/session"),
      opaque("PUT", token),
    );
    assert.equal(renewed.status, 200);
    const renewedToken = renewed.headers.get("X-Session-Token");
    assert.ok(renewedToken);
    for (const method of ["PUT", "DELETE"]) {
      const options = control(method, renewedToken);
      options.headers.Origin = "https://other.example.com";
      assert.equal(
        (await mf.dispatchFetch(url("/api/v1/session"), options)).status,
        404,
      );
    }
    const foreignLane = lane(renewedToken, 7);
    foreignLane.headers.Origin = "https://other.example.com";
    assert.equal(
      (await mf.dispatchFetch(url("/api/v1/ws"), foreignLane)).status,
      404,
    );
    const invalidLane = lane("invalid", 7);
    invalidLane.headers.Origin = "null";
    assert.equal(
      (await mf.dispatchFetch(url("/api/v1/ws"), invalidLane)).status,
      404,
    );
    const options = lane(renewedToken, 7);
    options.headers.Origin = "null";
    const wsResponse = await mf.dispatchFetch(url("/api/v1/ws"), options);
    assert.equal(wsResponse.status, 101);
    socket = wsResponse.webSocket;
    socket.accept();
    const closed = new Promise((resolve) =>
      socket.addEventListener("close", resolve, { once: true }),
    );
    assert.equal(
      (
        await mf.dispatchFetch(
          url("/api/v1/session"),
          opaque("DELETE", renewedToken),
        )
      ).status,
      204,
    );
    await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(Error("opaque-origin DELETE did not close lane")),
          2000,
        ),
      ),
    ]);
    assert.equal(
      (await mf.dispatchFetch(url("/api/v1/ws"), options)).status,
      409,
    );
  } finally {
    try {
      socket?.close();
    } catch {}
    await mf.dispose();
  }
});
