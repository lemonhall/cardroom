/**
 * Muster 的 HTTP 客户端：牌室这一侧唯一的"后端语言"。
 *
 * 这个文件刻意只做四件事：拼请求、发请求、量耗时、把响应原样交回去。
 * **它不认识游戏**——不认识 21 点、不认识牌、不认识结算。牌室的规则全在
 * `runtime/blackjack.js` 里，跑在平台的隔离区里。这一层薄到几乎没有存在感，
 * 就是它该有的样子（协议优于实现：换成别的后端，改的只是这个文件）。
 *
 * 三种鉴权通道都在这里，它们对应上游的三类调用方：
 *   - `Basic base64(server_key:)`：服务端之间（认证端点、控制台账本）
 *   - `Bearer <用户令牌>`：玩家本人（RPC、账号、排行榜）
 *   - `?http_key=<server_key>`：RPC 的第三种通道（本 demo 用不到，但它是真实存在的）
 */

export function basicAuth(serverKey) {
  return `Basic ${Buffer.from(`${serverKey}:`, "utf8").toString("base64")}`;
}

/**
 * 一次调用 = 一个结果对象。`status` / `ok` / `ms` / `path` 都留着，
 * 因为界面要把"刚才后端到底打了哪个端点、花了多久"如实显示出来。
 */
async function call(fetchImpl, baseUrl, method, path, { headers = {}, body, json = true } = {}) {
  const started = Date.now();
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  if (json) {
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  return {
    method,
    path,
    status: response.status,
    ok: response.ok,
    ms: Date.now() - started,
    body: parsed,
    text,
    headers: response.headers,
  };
}

export function createMuster({ baseUrl, fetchImpl = globalThis.fetch }) {
  const post = (path, options) => call(fetchImpl, baseUrl, "POST", path, options);
  const get = (path, options) => call(fetchImpl, baseUrl, "GET", path, options);

  return {
    baseUrl,

    /** 设备认证：服务端密钥换一个玩家会话。第一次调用会建号。 */
    async authenticateDevice(serverKey, deviceId, username) {
      // `username` 走 query（上游 authenticate 系列就是这么收的），body 只放 id。
      const query = username === undefined ? "" : `?username=${encodeURIComponent(username)}`;
      return await post(`/v2/account/authenticate/device${query}`, {
        headers: { authorization: basicAuth(serverKey) },
        body: { id: deviceId, create: true },
      });
    },

    /** RPC：调用租户模块注册的函数。载荷按上游规矩是一个 **JSON 字符串**。 */
    async rpc(token, name, payload) {
      return await post(`/v2/rpc/${encodeURIComponent(name)}`, {
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(payload === undefined ? "" : JSON.stringify(payload)),
      });
    },

    /** 账号：`wallet` 那一格是本 demo 的"筹码余额"真身（一份 JSON 文本）。 */
    async account(token) {
      return await get("/v2/account", { headers: { authorization: `Bearer ${token}` } });
    },

    /** 排行榜列表：`score` / `rank` 是字符串（int64 的 protojson 形态）。 */
    async leaderboard(token, id, limit) {
      return await get(`/v2/leaderboard/${encodeURIComponent(id)}?limit=${String(limit)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    },

    /** 控制台账本：**server key** 通道，运营视角的逐笔对账。 */
    async walletLedger(serverKey, userId, limit) {
      return await get(
        `/v2/console/account/${encodeURIComponent(userId)}/wallet-ledger?limit=${String(limit)}`,
        { headers: { authorization: basicAuth(serverKey) } },
      );
    },
  };
}

/** 把 RPC 的两种回包形状（`{payload}` 与裸文本）统一成"值 + 平台元信息"。 */
export function unwrapRpc(result) {
  const raw = result.body !== null && typeof result.body === "object" && "payload" in result.body
    ? result.body.payload
    : result.text;
  let value = null;
  try {
    value = typeof raw === "string" && raw !== "" ? JSON.parse(raw) : null;
  } catch {
    value = null;
  }
  return { value, raw, meta: { method: result.method, path: result.path, status: result.status, ms: result.ms } };
}
