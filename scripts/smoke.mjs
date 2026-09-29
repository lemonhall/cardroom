/**
 * 真链路 smoke：拿一个**已经跑起来的网关**打完整的一局，并逐条对账。
 *
 * 与 `npm test` 的分工：那里用假 Muster 钉契约（快、离线、每次都跑），
 * 这里用真后端走一遍（慢、要联网、显式调用）。同一个断言会在这里再出现一次，
 * 因为它要证明的是"真的那套也成立"，而不是"我的桩子同意我"。
 *
 * 用法：
 *   node scripts/smoke.mjs                              # 打本地网关 5173
 *   node scripts/smoke.mjs https://cardroom.<你的账号>.workers.dev
 *
 * 只读状态：不写代码、不改配置、不动 D1。它玩的这一局是**这个探针玩家自己**的账，
 * 每打一次就会多一局记录——这是它的代价，所以它不在 `npm test` 里。
 */

const BASE = (process.argv[2] ?? process.env.CARDROOM_BASE ?? "http://127.0.0.1:5173").replace(/\/$/u, "");
const BET = 50;

let cookie = "";
let failures = 0;

function check(label, condition, detail = "") {
  const mark = condition ? "  ok  " : " FAIL ";
  if (!condition) failures += 1;
  console.log(`[${mark}] ${label}${detail === "" ? "" : ` — ${detail}`}`);
}

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(cookie === "" ? {} : { cookie }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie !== null) cookie = setCookie.split(";")[0];
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  return { status: response.status, payload, text };
}

async function step(label, method, path, body) {
  const started = Date.now();
  const result = await call(method, path, body);
  const ms = Date.now() - started;
  const upstream = result.payload?.muster;
  const detail = `HTTP ${String(result.status)} · ${String(ms)}ms · ${upstream === undefined ? result.text.slice(0, 80) : `${String(upstream.path)} (${String(upstream.ms)}ms)`}`;
  check(label, result.status === 200 && result.payload?.ok === true, detail);
  return result.payload;
}

console.log(`目标：${BASE}\n`);

const who = await step("认设备 / 换玩家令牌", "GET", "/api/whoami");
check("拿到玩家身份", typeof who?.user?.id === "string", who?.user?.username ?? "");
check("租户与模块都在响应里", typeof who?.tenantId === "string" && typeof who?.module === "string");

const before = await step("读桌面状态", "GET", "/api/state");
if (before?.state?.phase === "player") {
  console.log("\n上一次留下一局没打完，先收掉它。");
  await step("停牌并结算（收尾）", "POST", "/api/stand", {});
}

const start = (await step("读桌面状态（开局前）", "GET", "/api/state")).state;
console.log(`  余额 ${String(start.chips)}｜牌鞋 ${String(start.shoeLeft)}｜局数 ${String(start.stats.rounds)}\n`);

let state = (await step(`下注 ${String(BET)} 并发牌`, "POST", "/api/deal", { bet: BET })).state;
check("发牌后进入要牌阶段", state.phase === "player", `phase=${state.phase}`);
check("扣注立刻体现在余额上", start.chips - state.chips === BET, `${String(start.chips)} → ${String(state.chips)}`);
check("玩家手上正好两张", state.player.cards.length === 2);
check("庄家只交出第一张牌，第二张是暗的", state.dealer.cards.length === 1 && state.dealer.hidden === 1);
// 开局的牌鞋是**发牌时才建的**：第一局开始前 `shoeLeft` 是 0，之后才有意义。
const shoeStart = start.shoeLeft === 0 ? state.shoeLeft + 4 : start.shoeLeft;
check("一手发掉四张（庄家两张，只有一张给你看）", shoeStart - state.shoeLeft === 4, `${String(shoeStart)} → ${String(state.shoeLeft)}`);
check("新牌鞋是两副牌", start.shoeLeft !== 0 || state.shoeLeft === 100, `发完剩 ${String(state.shoeLeft)} 张`);

let guard = 0;
while (state.phase === "player" && state.player.total < 17 && guard < 8) {
  guard += 1;
  const beforeHit = state.shoeLeft;
  state = (await step(`要牌（手上 ${String(state.player.total)} 点）`, "POST", "/api/hit", {})).state;
  check("每次要牌只多一张，牌鞋少一张", state.shoeLeft === beforeHit - 1, `现在 ${String(state.player.cards.length)} 张 / ${String(state.player.total)} 点`);
}

if (state.phase === "player") {
  state = (await step(`停牌并结算（手上 ${String(state.player.total)} 点）`, "POST", "/api/stand", {})).state;
}

check("结算后进入 settled", state.phase === "settled", `outcome=${String(state.outcome)}`);
check("庄家的暗牌被揭开", state.dealer.hidden === 0 && state.dealer.cards.length >= 2);
check("局数 +1", state.stats.rounds === start.stats.rounds + 1, `${String(start.stats.rounds)} → ${String(state.stats.rounds)}`);

const expected = state.outcome === "push" ? 0 : state.outcome === "lose" ? -BET : state.outcome === "blackjack" ? Math.floor(BET * 1.5) : BET;
check("赔付与结果一致", state.delta === expected, `${String(state.outcome)} → ${String(state.delta)}（应为 ${String(expected)}）`);
check(
  "这一局的净变化 = 结算给的 delta（扣注与赔付都已经算在里面）",
  state.chips - start.chips === state.delta,
  `${String(start.chips)} → ${String(state.chips)}，delta=${String(state.delta)}`,
);
check("累计净胜与这一局一致", state.stats.net === start.stats.net + state.delta, `net=${String(state.stats.net)}`);

const board = await step("读排行榜（玩家令牌通道）", "GET", "/api/board");
const mine = (board?.records ?? []).find((row) => row.mine === true);
check("自己出现在榜单上", mine !== undefined, mine === undefined ? "" : `第 ${String(mine.rank)} 名 · ${String(mine.score)}`);
check("榜单分数就是累计净胜", mine !== undefined && mine.score === state.stats.net, `${String(mine?.score)} vs ${String(state.stats.net)}`);

const ledger = await step("读控制台账本（server key 通道）", "GET", "/api/ledger");
const newest = (ledger?.entries ?? [])[0];
check("账本最新一条是这一局", newest !== undefined && newest.metadata.round === state.stats.rounds, newest === undefined ? "" : `${String(newest.metadata.reason)} · 第 ${String(newest.metadata.round)} 局`);

const account = await step("读账号钱包", "GET", "/api/account");
check("钱包余额与桌面状态一致", account?.wallet?.chips === state.chips, `${String(account?.wallet?.chips)} vs ${String(state.chips)}`);

console.log(failures === 0 ? "\n全通过：这一局从头到尾都对得上。" : `\n有 ${String(failures)} 条不对，别急着上线。`);
process.exit(failures === 0 ? 0 : 1);
