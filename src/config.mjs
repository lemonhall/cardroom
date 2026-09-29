/**
 * 配置：把 `.env` 与进程环境读成一份显式的对象。
 *
 * 这个文件被两处用：`scripts/setup.mjs`（要往 `.env` 里写回租户与 server key）与
 * `src/gateway.mjs`（要读它）。所以"读"与"改"都放在这里，别的地方不许自己解析 `.env`。
 *
 * 约定（照着 Muster 那份工程标准来）：
 *   - 显式优于隐式：所有旋钮都有默认值，但默认值写在下面这一处；
 *   - 幂等：`updateEnvFile` 对同一个键改一百次，结果都一样。
 */

import fs from "node:fs";
import path from "node:path";

export const DEFAULTS = {
  MUSTER_BASE: "http://127.0.0.1:8787",
  CARDROOM_PORT: "5173",
  MUSTER_DIR: "../muster",
  CARDROOM_MODULE: "blackjack",
  CARDROOM_LEADERBOARD: "cardroom-net",
};

/** 极简 `.env`：`KEY=VALUE`，`#` 开头是注释，值两边的引号会被剥掉。 */
export function parseEnvFile(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  return parseEnvFile(fs.readFileSync(file, "utf8"));
}

/** 原地改键值：已存在的键改值，缺的键追加，其余行（含注释）一个字都不动。 */
export function updateEnvFile(file, patch) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/u) : [];
  const remaining = new Map(Object.entries(patch));
  const out = lines.map((line) => {
    const at = line.indexOf("=");
    if (at <= 0 || line.trim().startsWith("#")) return line;
    const key = line.slice(0, at).trim();
    if (!remaining.has(key)) return line;
    const value = remaining.get(key);
    remaining.delete(key);
    return `${key}=${value}`;
  });
  // 追加时先吃掉"文件末尾那个换行留下的空行"，否则每加一个键都会多插一条空行。
  // 有意留的空行（连着两个换行）不受影响：这里只吃一条。
  if (remaining.size > 0 && out.length > 0 && out[out.length - 1] === "") out.pop();
  for (const [key, value] of remaining) out.push(`${key}=${value}`);
  fs.writeFileSync(file, `${out.join("\n").replace(/\n+$/u, "")}\n`, "utf8");
}

/** 进程环境优先，其次 `.env`，最后默认值——这样 CI 里可以整段覆盖。 */
export function loadConfig({ root, env = process.env } = {}) {
  const repoRoot = root ?? process.cwd();
  const envFile = path.join(repoRoot, ".env");
  const file = readEnvFile(envFile);
  const pick = (key) => {
    const fromEnv = env[key];
    if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
    const fromFile = file[key];
    if (typeof fromFile === "string" && fromFile.trim() !== "") return fromFile.trim();
    return DEFAULTS[key] ?? "";
  };
  return {
    root: repoRoot,
    envFile,
    musterBase: pick("MUSTER_BASE").replace(/\/+$/u, ""),
    port: Number(pick("CARDROOM_PORT")),
    musterDir: path.resolve(repoRoot, pick("MUSTER_DIR")),
    moduleName: pick("CARDROOM_MODULE"),
    leaderboardId: pick("CARDROOM_LEADERBOARD"),
    tenantId: pick("CARDROOM_TENANT_ID"),
    serverKey: pick("CARDROOM_SERVER_KEY"),
  };
}
