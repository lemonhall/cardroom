/**
 * Muster 客户端的测试：请求形状与回包解包。
 *
 * 三条**协议级**的约定在这里钉住，它们各自都曾经是"写错了还能跑"的那类错误：
 *
 *   1. Basic 认证的用户名是**空的**：`Basic base64("<server key>:")`；
 *   2. RPC 的请求体是一个 **JSON 字符串**（不是对象）——上游模仿 grpc-gateway 的
 *      那段行为，客户端 SDK 自己再解一次；
 *   3. 回包可能是 `{payload:"<字符串>"}` 也可能是裸文本，解包必须两种都吃。
 *
 * 用的是注入的假 `fetch`，所以这里不打后端、不起 workerd。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { basicAuth, createMuster, unwrapRpc } from "../src/muster.mjs";

/** 一个记账用的假 fetch：把每次调用记下来，按顺序回给定的响应。 */
function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, ...options });
    const next = responses[calls.length - 1] ?? { status: 200, body: "{}" };
    return new Response(next.body, { status: next.status ?? 200 });
  };
  return { impl, calls };
}

test("basicAuth 是 base64(<key>:)，冒号不能少", () => {
  assert.equal(basicAuth("abc"), `Basic ${Buffer.from("abc:").toString("base64")}`);
  assert.equal(Buffer.from("YWJjOg==", "base64").toString("utf8"), "abc:");
});

test("unwrapRpc：包在 payload 里的 JSON 字符串、裸文本、坏 JSON 三种都能吃", () => {
  const wrapped = unwrapRpc({ method: "POST", path: "/v2/rpc/state", status: 200, ms: 3, body: { payload: '{"a":1}' }, text: "" });
  assert.deepEqual(wrapped.value, { a: 1 });
  assert.deepEqual(wrapped.meta, { method: "POST", path: "/v2/rpc/state", status: 200, ms: 3 });

  const bare = unwrapRpc({ method: "GET", path: "/x", status: 200, ms: 1, body: null, text: '"plain"' });
  assert.equal(bare.value, "plain");

  const broken = unwrapRpc({ method: "GET", path: "/x", status: 500, ms: 1, body: null, text: "boom" });
  assert.equal(broken.value, null);
  assert.equal(broken.raw, "boom");
});

test("认证：走 query 传用户名、body 只放 id，且带 Basic 头", async () => {
  const { impl, calls } = fakeFetch([{ body: '{"token":"t","refresh_token":"r","created":true}' }]);
  const muster = createMuster({ baseUrl: "http://x", fetchImpl: impl });

  const result = await muster.authenticateDevice("k", "d", "player_1");
  assert.equal(result.body.token, "t");
  assert.equal(calls[0].url, "http://x/v2/account/authenticate/device?username=player_1");
  assert.equal(calls[0].headers.authorization, basicAuth("k"));
  assert.equal(calls[0].body, '{"id":"d","create":true}');
});

test("RPC：载荷被序列化成**字符串**，路径转义，带 Bearer 令牌", async () => {
  const { impl, calls } = fakeFetch([{ body: '{"payload":"null"}' }]);
  const muster = createMuster({ baseUrl: "http://x", fetchImpl: impl });

  await muster.rpc("tok", "my/name", { bet: 50 });
  assert.equal(calls[0].url, "http://x/v2/rpc/my%2Fname");
  assert.equal(calls[0].headers.authorization, "Bearer tok");
  // 外层是 JSON 字符串字面量，内层才是我们的载荷——上游就是这么收的。
  assert.equal(calls[0].body, JSON.stringify(JSON.stringify({ bet: 50 })));

  await muster.rpc("tok", "state", undefined);
  assert.equal(calls[1].body, '""');
});

test("榜单与账本：limit 走 query，账本走 server key 那条通道", async () => {
  const { impl, calls } = fakeFetch([{ body: '{"records":[]}' }, { body: '{"items":[]}' }]);
  const muster = createMuster({ baseUrl: "http://x", fetchImpl: impl });

  await muster.leaderboard("tok", "board", 10);
  assert.equal(calls[0].url, "http://x/v2/leaderboard/board?limit=10");
  assert.equal(calls[0].headers.authorization, "Bearer tok");

  await muster.walletLedger("k", "u-1", 5);
  assert.equal(calls[1].url, "http://x/v2/console/account/u-1/wallet-ledger?limit=5");
  assert.equal(calls[1].headers.authorization, basicAuth("k"));
});

test("耗时与状态都留在结果里（界面要显示它）", async () => {
  const { impl } = fakeFetch([{ status: 404, body: "nope" }]);
  const muster = createMuster({ baseUrl: "http://x", fetchImpl: impl });
  const result = await muster.account("tok");
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.method, "GET");
  assert.ok(typeof result.ms === "number" && result.ms >= 0);
});
