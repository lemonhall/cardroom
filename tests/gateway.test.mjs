/**
 * 网关的**契约测试**：用一个假 Muster 把真正要保证的东西钉死。
 *
 * 为什么值得单独写：网关是浏览器唯一能碰到的东西，它做对了三件事才有资格上线——
 *   1. **密钥不出服务端**：响应里永远不该出现 server key，也不该出现玩家令牌；
 *   2. **两条鉴权通道不能串**：榜单走玩家令牌、账本走 server key，走错就是越权；
 *   3. **静态文件不能越界**：`/../.env` 必须 404，而不是把仓库读出去。
 *
 * 假 Muster 只在内存里，不联网、不起 workerd，所以它是 `npm test` 的一部分。
 * 真后端的那条路在 `scripts/smoke.mjs`（要显式给 BASE，见 README）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createGateway } from "../src/gateway.mjs";

const DEVICE = "a".repeat(32);
const USER_ID = "user-1";
const SERVER_KEY = "server-key-should-never-leak";

/** 一个假的 Muster：记住每次调用，按端点回固定形状的包。 */
function stubMuster() {
  const calls = [];
  const record = (entry) => {
    calls.push(entry);
    return entry;
  };
  const ok = (method, path, body) => ({ method, path, status: 200, ok: true, ms: 3, body, text: JSON.stringify(body), headers: new Headers() });

  return {
    calls,
    of: (path) => calls.filter((entry) => entry.path.startsWith(path)),
    async authenticateDevice(serverKey, deviceId, username) {
      record({ channel: "server", path: "/v2/account/authenticate/device", serverKey, deviceId, username });
      return ok("POST", "/v2/account/authenticate/device", { token: "player-token", refresh_token: "r", created: true });
    },
    async account(token) {
      record({ channel: "player", path: "/v2/account", token });
      return ok("GET", "/v2/account", { user: { id: USER_ID, username: "player_aaaaaaaa" }, wallet: JSON.stringify({ chips: 1000 }) });
    },
    async rpc(token, name, payload) {
      record({ channel: "player", path: `/v2/rpc/${name}`, token, payload });
      const state = { phase: "idle", chips: 1000, bet: 0, outcome: null, delta: 0, shoeLeft: 104, stats: { rounds: 0, wins: 0, losses: 0, pushes: 0, net: 0 }, player: { cards: [], total: 0 }, dealer: { cards: [], hidden: 0, total: 0 } };
      return ok("POST", `/v2/rpc/${name}`, { payload: JSON.stringify(state) });
    },
    async leaderboard(token, id, limit) {
      record({ channel: "player", path: `/v2/leaderboard/${id}`, token, limit });
      return ok("GET", `/v2/leaderboard/${id}`, { records: [{ owner_id: USER_ID, username: "player_aaaaaaaa", score: "120", rank: "1" }] });
    },
    async walletLedger(serverKey, userId, limit) {
      record({ channel: "server", path: `/v2/console/account/${userId}/wallet-ledger`, serverKey, limit });
      return ok("GET", "/v2/console/account/wallet-ledger", { items: [{ id: "l1", changeset: JSON.stringify({ chips: -50 }), metadata: JSON.stringify({ reason: "bet", round: 1 }), create_time: "now" }] });
    },
  };
}

async function withGateway(work) {
  const muster = stubMuster();
  const config = { musterBase: "http://muster.invalid", tenantId: "tenant-1", moduleName: "blackjack", leaderboardId: "cardroom-net", serverKey: SERVER_KEY, port: 0 };
  const server = createGateway({ config, muster, publicDir: fileURLToPath(new URL("../public", import.meta.url)) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${String(server.address().port)}`;
  try {
    await work({ base, muster });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function get(base, path, cookie) {
  const response = await fetch(`${base}${path}`, { headers: cookie === undefined ? {} : { cookie } });
  const raw = await response.text();
  return { response, raw, payload: JSON.parse(raw) };
}

test("whoami：第一次来就发一个设备 cookie，并把租户与模块如实报出来", async () => {
  await withGateway(async ({ base, muster }) => {
    const response = await fetch(`${base}/api/whoami`);
    const payload = await response.json();
    const cookie = response.headers.get("set-cookie");
    assert.match(cookie, /^cardroom_device=[0-9a-f]{32}; Path=\/; HttpOnly/u);
    assert.equal(payload.user.id, USER_ID);
    assert.equal(payload.tenantId, "tenant-1");
    assert.equal(payload.module, "blackjack");
    assert.equal(muster.of("/v2/account/authenticate/device").length, 1);
  });
});

test("令牌与 server key 都不出现在响应里", async () => {
  await withGateway(async ({ base }) => {
    for (const path of ["/api/whoami", "/api/state", "/api/board", "/api/ledger", "/api/account"]) {
      const response = await fetch(`${base}${path}`, { headers: { cookie: `cardroom_device=${DEVICE}` } });
      const text = await response.text();
      assert.ok(!text.includes(SERVER_KEY), `${path} 泄漏了 server key`);
      assert.ok(!text.includes("player-token"), `${path} 泄漏了玩家令牌`);
    }
  });
});

test("同一个设备重复访问只认证一次（会话是缓存的）", async () => {
  await withGateway(async ({ base, muster }) => {
    await fetch(`${base}/api/state`, { headers: { cookie: `cardroom_device=${DEVICE}` } });
    await fetch(`${base}/api/state`, { headers: { cookie: `cardroom_device=${DEVICE}` } });
    assert.equal(muster.of("/v2/account/authenticate/device").length, 1);
  });
});

test("state 把 RPC 的 JSON 字符串拆成对象，并带上上游元信息", async () => {
  await withGateway(async ({ base, muster }) => {
    const { payload } = await get(base, "/api/state", `cardroom_device=${DEVICE}`);
    assert.equal(payload.ok, true);
    assert.equal(payload.state.chips, 1000);
    assert.equal(payload.muster.path, "/v2/rpc/state");
    assert.equal(muster.of("/v2/rpc/state")[0].channel, "player");
  });
});

test("deal 把下注额原样交给 RPC", async () => {
  await withGateway(async ({ base, muster }) => {
    const response = await fetch(`${base}/api/deal`, {
      method: "POST",
      headers: { cookie: `cardroom_device=${DEVICE}`, "content-type": "application/json" },
      body: JSON.stringify({ bet: 50 }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(muster.of("/v2/rpc/deal")[0].payload, { bet: 50 });
  });
});

test("榜单走玩家令牌、账本走 server key——两条通道不许串", async () => {
  await withGateway(async ({ base, muster }) => {
    const board = await get(base, "/api/board", `cardroom_device=${DEVICE}`);
    assert.equal(muster.of("/v2/leaderboard")[0].channel, "player");
    assert.equal(board.payload.records[0].mine, true);
    assert.equal(board.payload.records[0].score, 120);

    const ledger = await get(base, "/api/ledger", `cardroom_device=${DEVICE}`);
    const call = muster.of("/v2/console/account")[0];
    assert.equal(call.channel, "server");
    assert.equal(call.serverKey, SERVER_KEY);
    assert.deepEqual(ledger.payload.entries[0].changeset, { chips: -50 });
    assert.deepEqual(ledger.payload.entries[0].metadata, { reason: "bet", round: 1 });
  });
});

test("静态文件只从 public/ 里出，目录穿越被挡在门外", async () => {
  await withGateway(async ({ base }) => {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /CARDROOM/u);

    for (const path of ["/../.env", "/..%2f.env", "/styles/../../.env"]) {
      const escape = await fetch(`${base}${path}`);
      assert.equal(escape.status, 404, `${path} 不该能读到`);
    }
  });
});

test("不存在的端点返回 404 与一句人话", async () => {
  await withGateway(async ({ base }) => {
    const response = await fetch(`${base}/api/nope`);
    assert.equal(response.status, 404);
    const payload = await response.json();
    assert.equal(payload.ok, false);
    assert.match(payload.error, /没有这个端点/u);
  });
});
