/**
 * 一次性准备：把"一个游戏"在平台上立起来。
 *
 * 三件事，全部作用在**本地** D1 上（`--local`），不碰任何远端资源，因此不产生账单：
 *
 *   1. 把 Muster 的迁移打到本地库（幂等，跑一百次都一样）；
 *   2. 开通/校正这个牌室的租户，并把 server key 写进 `.env`；
 *   3. 把 `runtime/*.js` 作为运行时模块部署进 `runtime_modules`。
 *      这次是两个：`blackjack`（RPC 入口）与 `blackjack-rules`（纯规则，被前者
 *      `import`）。模块名同时是**装载别名**：`import "./blackjack-rules.js"` 能解析，
 *      靠的就是平台为每个模块按名字多挂了一条路径。
 *
 * 为什么用 wrangler 直连本地 D1 而不是走 HTTP：平台**刻意没有**"开通租户"与
 * "上传模块"这两条 HTTP 接口（它们是运维动作，不该从游戏客户端那条路上来）。
 * 所以这一步由人跑、由脚本读库自证。
 *
 * 幂等性怎么保证：
 *   - 租户那条 SQL 是 `ON CONFLICT DO UPDATE`，`.env` 是唯一事实源；
 *   - 模块只在**源码变了**时才写新 revision（revision 必须单调递增，
 *     否则改了代码却因为哈希变小而装载到旧版本——这是这套装载键的陷阱）。
 */

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { loadConfig, updateEnvFile } from "../src/config.mjs";

const DATABASE = "muster";
const TENANT_NAME = "cardroom";

/**
 * 要部署的模块清单。**顺序与名字都是接口的一部分**：
 *   - 名字必须与模块内部 `import "./<名字>.js"` 的写法对得上；
 *   - `blackjack` 是入口，它注册 RPC；`blackjack-rules` 只是被它 import 的兄弟模块。
 */
const MODULES = [
  { name: "blackjack", file: "runtime/blackjack.js" },
  { name: "blackjack-rules", file: "runtime/blackjack-rules.js" },
];

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

function wrangler(config, args) {
  const bin = path.join(config.musterDir, "node_modules", "wrangler", "bin", "wrangler.js");
  if (!fs.existsSync(bin)) {
    throw new Error(
      `找不到 wrangler：${bin}\n` +
        `请先在 ${config.musterDir} 里跑一次 npm install，或用 MUSTER_DIR 指到 Muster 的 checkout。`,
    );
  }
  const output = execFileSync(process.execPath, [bin, ...args], {
    cwd: config.musterDir,
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    encoding: "utf8",
  });
  return output;
}

/** `wrangler d1 execute ... --json` 的输出是 `[{results: [...]}]`。 */
function query(config, sql) {
  const output = wrangler(config, ["d1", "execute", DATABASE, "--local", "--json", "--command", sql, "--yes"]);
  const at = output.indexOf("[");
  if (at < 0) return [];
  const parsed = JSON.parse(output.slice(at));
  return Array.isArray(parsed) ? (parsed[0]?.results ?? []) : [];
}

function execute(config, sql) {
  wrangler(config, ["d1", "execute", DATABASE, "--local", "--command", sql, "--yes"]);
}

function ensureTenant(config, log) {
  let { tenantId, serverKey } = config;
  let generated = false;
  if (tenantId === "" || serverKey === "") {
    tenantId = tenantId === "" ? crypto.randomUUID().toUpperCase() : tenantId;
    serverKey = serverKey === "" ? crypto.randomBytes(32).toString("base64url") : serverKey;
    updateEnvFile(config.envFile, { CARDROOM_TENANT_ID: tenantId, CARDROOM_SERVER_KEY: serverKey });
    generated = true;
  }

  const now = Math.floor(Date.now() / 1000);
  // 幂等 + 自愈：`.env` 里那份 key 永远是准的，库里跟着它走。
  execute(
    config,
    "INSERT INTO tenants (id, name, server_key_hash, create_time, disable_time) VALUES (" +
      [sqlLiteral(tenantId), sqlLiteral(TENANT_NAME), sqlLiteral(sha256Hex(serverKey)), String(now), "0"].join(", ") +
      ") ON CONFLICT(id) DO UPDATE SET server_key_hash = excluded.server_key_hash, name = excluded.name;",
  );
  log(`租户：${tenantId}（${generated ? "本次生成，已写入 .env" : "沿用 .env"}）`);
  return { tenantId, serverKey };
}

/** 每个模块各自一条 revision 线；源码没变就不写新版本（这样 isolate 也不会被重建）。 */
function deployModule(config, log, module) {
  const source = fs.readFileSync(path.join(config.root, module.file), "utf8");
  const current = query(
    config,
    "SELECT revision, source FROM runtime_modules WHERE tenant_id = " +
      `${sqlLiteral(config.tenantId)} AND name = ${sqlLiteral(module.name)} ` +
      "ORDER BY revision DESC LIMIT 1;",
  );
  const latest = current.length === 0 ? null : current[0];
  if (latest !== null && latest.revision !== undefined && String(latest.source ?? "") === source) {
    log(`模块：${module.name} revision=${String(latest.revision)}（源码没变，跳过）`);
    return;
  }
  const revision = latest === null ? 1 : Number(latest.revision) + 1;
  execute(
    config,
    "INSERT OR REPLACE INTO runtime_modules (tenant_id, name, revision, source, created_at) VALUES (" +
      [
        sqlLiteral(config.tenantId),
        sqlLiteral(module.name),
        String(revision),
        sqlLiteral(source),
        sqlLiteral(new Date().toISOString()),
      ].join(", ") +
      ");",
  );
  log(`模块：${module.name} revision=${String(revision)}（已部署 ${String(source.length)} 字节）`);
}

const config = loadConfig();

if (!fs.existsSync(config.musterDir)) {
  console.error(`找不到 Muster 的 checkout：${config.musterDir}\n请在 .env 里改 MUSTER_DIR。`);
  process.exit(1);
}

console.log(`后端：${config.musterBase}`);
console.log(`Muster checkout：${config.musterDir}`);
console.log("1/3 应用本地 D1 迁移…");
// `d1 migrations apply` 不吃 `--yes`：它靠 CI=true（上面 env 里已设）跳过确认。
wrangler(config, ["d1", "migrations", "apply", DATABASE, "--local"]);

console.log("2/3 开通/校正租户…");
const tenant = ensureTenant(config, console.log);
const resolved = { ...config, ...tenant };

console.log("3/3 部署游戏模块…");
for (const module of MODULES) deployModule(resolved, console.log, module);

console.log(
  [
    "",
    "好了。接下来两条命令：",
    `  1) 起后端： cd ${resolved.musterDir}`,
    "             npm run dev",
    "  2) 起牌室： npm start（在本仓库里）",
    "",
    "改了 runtime/*.js 之后重新跑一次 `npm run setup` 就会部署新 revision。",
  ].join("\n"),
);
