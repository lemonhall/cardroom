/**
 * 牌室的本地网关：浏览器唯一的对话方。
 *
 * 它存在的理由有三条，都不是"图方便"：
 *
 *   1. **密钥不出服务端**。租户 server key 只在这台机器上，浏览器一个密钥都没有；
 *      玩家令牌也由这里保管（cookie 里只有一个设备 id）。
 *   2. **浏览器不该直连后端**。Muster 是给游戏客户端用的 API，不带 CORS 头，
 *      一条 `<script>` 打不通它——真做线上时这里会是一个正经的 BFF。
 *   3. **看得见中间发生了什么**。每个响应都带 `muster` 元信息（方法、路径、状态、耗时），
 *      界面把它原样显示出来，你就能一条条数"这一步谁在干活"。
 *
 * 这一层**不含任何游戏规则**：它只会转发 `/api/deal` → RPC `deal`。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.mjs";
import { createMuster, unwrapRpc } from "./muster.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC = path.join(HERE, "..", "public");

/**
 * 静态文件：只认下面这张表里的后缀，路径解析后必须还在 `public/` 里。
 *
 * 这是"网关也是唯一的出口"的一部分：浏览器拿到的每一个字节都从这条路由出去，
 * 所以不存在"另一个端口上跑着前端"这种需要解释的部署形状。
 */
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** 命中就返回 Buffer，否则返回 null（由调用方回 404）。 */
function readStatic(publicDir, pathname) {
  const root = path.resolve(publicDir);
  const wanted = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/u, "");
  const target = path.resolve(root, wanted);
  // 目录穿越（`/../.env`）在这里被挡住：解析完的路径必须还在 public/ 里面。
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  const type = STATIC_TYPES[path.extname(target).toLowerCase()];
  if (type === undefined || !fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  return { body: fs.readFileSync(target), type };
}

const DEVICE_COOKIE = "cardroom_device";
const MAX_BODY = 4096;

function jsonBody(response, status, payload, extraHeaders = {}) {
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  response.end(text);
}

function readCookies(request) {
  const header = request.headers.cookie ?? "";
  const jar = {};
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    jar[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
  }
  return jar;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("请求体太大");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  return JSON.parse(text);
}

/** 设备 id → 玩家会话。令牌缓存在内存里，进程重启就重新换一次。 */
function createSessions({ muster, serverKey }) {
  const cache = new Map();
  return async function ensureSession(deviceId) {
    const cached = cache.get(deviceId);
    if (cached !== undefined) return cached;

    const auth = await muster.authenticateDevice(serverKey, deviceId, `player_${deviceId.slice(0, 8)}`);
    if (!auth.ok) throw new Error(`设备认证失败（HTTP ${String(auth.status)}）：${auth.text.slice(0, 200)}`);
    const token = auth.body.token;
    const account = await muster.account(token);
    if (!account.ok) throw new Error(`读账号失败（HTTP ${String(account.status)}）：${account.text.slice(0, 200)}`);
    const session = {
      token,
      refreshToken: auth.body.refresh_token,
      userId: String(account.body.user.id),
      username: String(account.body.user.username),
      created: auth.body.created === true,
    };
    cache.set(deviceId, session);
    return session;
  };
}

function walletOf(accountBody) {
  try {
    return JSON.parse(String(accountBody.wallet ?? "{}"));
  } catch {
    return {};
  }
}

export function createGateway({ config, muster, publicDir = DEFAULT_PUBLIC }) {
  const ensureSession = createSessions({ muster, serverKey: config.serverKey });

  /** 会话 + 平台元信息：所有 `/api/*` 都从这里出发。 */
  async function withSession(request, response, handler) {
    const jar = readCookies(request);
    let deviceId = jar[DEVICE_COOKIE];
    const headers = {};
    if (deviceId === undefined || !/^[0-9a-f]{32}$/u.test(deviceId)) {
      deviceId = crypto.randomBytes(16).toString("hex");
      headers["set-cookie"] = `${DEVICE_COOKIE}=${deviceId}; Path=/; HttpOnly; SameSite=Lax`;
    }
    const session = await ensureSession(deviceId);
    await handler(session, headers);
  }

  async function gameRpc(session, response, headers, name, payload) {
    const result = await muster.rpc(session.token, name, payload);
    const { value, meta } = unwrapRpc(result);
    if (!result.ok) {
      const message = result.body !== null && typeof result.body === "object" && "message" in result.body
        ? String(result.body.message)
        : result.text.slice(0, 200);
      jsonBody(response, result.status, { ok: false, error: message, muster: meta }, headers);
      return;
    }
    jsonBody(response, 200, { ok: true, state: value, muster: meta }, headers);
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const route = `${request.method ?? "GET"} ${url.pathname}`;

    if (request.method === "GET" || request.method === "HEAD") {
      const asset = readStatic(publicDir, url.pathname);
      if (asset !== null) {
        response.writeHead(200, {
          "content-type": asset.type,
          "content-length": asset.body.length,
          "cache-control": "no-store",
        });
        response.end(request.method === "HEAD" ? undefined : asset.body);
        return;
      }
    }

    const guard = (work) => {
      work().catch((error) => {
        jsonBody(response, 502, { ok: false, error: `网关这一侧出错了：${String(error.message ?? error)}` });
      });
    };

    if (route === "GET /api/whoami") {
      guard(() => withSession(request, response, async (session, headers) => {
        jsonBody(response, 200, {
          ok: true,
          musterBase: config.musterBase,
          tenantId: config.tenantId,
          module: config.moduleName,
          leaderboard: config.leaderboardId,
          user: { id: session.userId, username: session.username, createdThisRun: session.created },
        }, headers);
      }));
      return;
    }

    if (route === "GET /api/state") {
      guard(() => withSession(request, response, async (session, headers) => {
        await gameRpc(session, response, headers, "state", undefined);
      }));
      return;
    }

    if (route === "POST /api/deal" || route === "POST /api/hit" || route === "POST /api/stand") {
      const name = url.pathname.slice("/api/".length);
      guard(() => withSession(request, response, async (session, headers) => {
        const input = await readJson(request);
        await gameRpc(session, response, headers, name, input);
      }));
      return;
    }

    // 榜单与账本走**两条不同的鉴权通道**：榜单是玩家令牌，账本是租户 server key。
    // 放在一起看，就明白"平台把玩家视角与运营视角分开了"。
    if (route === "GET /api/board") {
      guard(() => withSession(request, response, async (session, headers) => {
        const result = await muster.leaderboard(session.token, config.leaderboardId, 10);
        const { meta } = unwrapRpc(result);
        const records = result.ok ? (result.body.records ?? []) : [];
        jsonBody(response, 200, {
          ok: result.ok,
          records: records.map((row) => ({
            ownerId: row.owner_id,
            username: row.username ?? "(未起名)",
            score: Number(row.score ?? 0),
            rank: Number(row.rank ?? 0),
            mine: row.owner_id === session.userId,
          })),
          muster: meta,
        }, headers);
      }));
      return;
    }

    if (route === "GET /api/ledger") {
      guard(() => withSession(request, response, async (session, headers) => {
        const result = await muster.walletLedger(config.serverKey, session.userId, 10);
        const { meta } = unwrapRpc(result);
        jsonBody(response, 200, {
          ok: result.ok,
          entries: result.ok ? (result.body.items ?? []).map((item) => ({
            id: item.id,
            changeset: JSON.parse(String(item.changeset ?? "{}")),
            metadata: JSON.parse(String(item.metadata ?? "{}")),
            createTime: item.create_time,
          })) : [],
          muster: meta,
        }, headers);
      }));
      return;
    }

    if (url.pathname === "/api/account") {
      guard(() => withSession(request, response, async (session, headers) => {
        const account = await muster.account(session.token);
        jsonBody(response, 200, {
          ok: account.ok,
          wallet: account.ok ? walletOf(account.body) : {},
          muster: { method: "GET", path: "/v2/account", status: account.status, ms: account.ms },
        }, headers);
      }));
      return;
    }

    jsonBody(response, 404, { ok: false, error: `没有这个端点：${route}` });
  });

  return server;
}

export async function startGateway({ config = loadConfig(), log = console.log } = {}) {
  const muster = createMuster({ baseUrl: config.musterBase });
  const server = createGateway({ config, muster });
  await new Promise((resolve) => server.listen(config.port, "127.0.0.1", resolve));
  log(`牌室已就绪：http://127.0.0.1:${String(config.port)}`);
  log(`后端：${config.musterBase}｜租户：${config.tenantId}｜模块：${config.moduleName}`);
  return server;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const config = loadConfig();
  if (config.tenantId === "" || config.serverKey === "") {
    console.error("还没有租户。先跑一次：npm run setup");
    process.exit(1);
  }
  await startGateway({ config });
}
