/**
 * 打一条任意 RPC 的开发工具：`node scripts/probe.mjs <name> '<json>'`。
 *
 * 它**不走网关**，直接用租户 server key 换一个固定的"探针玩家"令牌再调 RPC。
 * 固定设备 id 是刻意的：探针玩家只有一个，反复探测不会在库里堆出一串假账号。
 * 这个脚本只连 `.env` 里那个后端，别的一切照旧。
 */

import { loadConfig } from "../src/config.mjs";
import { createMuster, unwrapRpc } from "../src/muster.mjs";

const PROBE_DEVICE = "0123456789abcdef0123456789abcdef";

const [name, raw = ""] = process.argv.slice(2);
if (name === undefined || name === "") {
  console.error("用法：node scripts/probe.mjs <rpc 名> '<JSON 载荷>'");
  process.exit(1);
}

const config = loadConfig();
const muster = createMuster({ baseUrl: config.musterBase });

const auth = await muster.authenticateDevice(config.serverKey, PROBE_DEVICE, "player_probe");
if (!auth.ok) throw new Error(`设备认证失败（HTTP ${String(auth.status)}）：${auth.text.slice(0, 200)}`);
const token = auth.body.token;

let payload;
try {
  payload = raw === "" ? undefined : JSON.parse(raw);
} catch {
  console.error(`载荷不是合法 JSON：${raw}`);
  process.exit(1);
}

const result = await muster.rpc(token, name, payload);
const { value, meta } = unwrapRpc(result);
console.log(`POST ${meta.path} → ${String(meta.status)}（${String(meta.ms)}ms）`);
console.log(JSON.stringify(value ?? result.text, null, 2));
