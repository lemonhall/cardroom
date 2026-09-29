/**
 * 牌室的**游戏模块**：被平台装载进一个独立 isolate，由 RPC 触发执行。
 *
 * 浏览器只能发"意图"（下注、要牌、停牌），**牌是这里发的、分是这里算的**。
 * 规则本身在同目录的 `blackjack-rules.js`（纯函数，本地 `node --test` 直接跑它）；
 * 这个文件只做两件事：把规则接到平台能力上，把结果整理成前端要的形状。
 *
 * 它只用平台上真实存在的能力面（`nk`）：
 *
 *   nk.uuidv4             → 洗牌的随机源（平台给，不用 Math.random）
 *   nk.storageRead/Write  → 牌桌状态与战绩存档（每个玩家一份文档）
 *   nk.walletUpdate       → 筹码：扣注、赔付，同时落一条账本行供对账
 *   nk.walletLedgerList   → 把最近几笔账本回给客户端（透明即信任）
 *   nk.leaderboardCreate  → 懒创建"累计净胜"榜（幂等）
 *   nk.leaderboardRecordWrite → 每局把净胜写进榜（INCREMENT 算子）
 *
 * ## 一条必须守的规矩：`nk` 只能来自**这一次调用**的参数
 *
 * `InitModule` 的签名里有 `nk`，handler 的签名里**也有** `nk`。两个不是一回事：
 * 平台的能力对象是"每次调用现造"的，它背后的 RPC 会话在这一次调用返回时就关闭。
 * 把 `InitModule` 那个 `nk` 存进闭包、下一次调用再用，workerd 会直接拒绝：
 *
 *   `RPC stub used after being disposed.`
 *
 * 这条限制不是麻烦，是**跨请求身份不泄漏**的保证：上一次请求的调用者身份不会
 * 悄悄留在模块里。所以本文件里所有 handler 都写成 `(ctx, logger, nk, payload)`
 * ——与上游 JS 运行时的签名一致——并且只用参数里那份 `nk`。
 *
 * 同一条"跨 isolate"的性质还有第二个后果：**`nk.*` 全都返回 Promise，必须 await**。
 * 上游 Nakama 的 JS 运行时是同步调用，所以照抄过来的代码很容易忘记 await；忘了的
 * 表现是"拿到一个 RPC promise 而不是值"，然后一路静默地算出垃圾（本项目第一版就是：
 * 随机数全 NaN，洗出来的牌鞋是原始顺序，牌一发就是 null）。这条差异在平台文档里
 * 是登记过的（ECN-0012 偏差 2），但它在模块这一侧只有一个症状：**你不 await，它不报错**。
 */

import {
  DECKS,
  RESHUFFLE_BELOW,
  STARTING_CHIPS,
  assertBet,
  dealerShouldHit,
  emptyStats,
  handValue,
  isBlackjack,
  newShoe,
  resolveRound,
  visibleDealer,
} from "./blackjack-rules.js";

const COLLECTION = "cardroom";
const TABLE_KEY = "table";
const STATS_KEY = "stats";
const LEADERBOARD = "cardroom-net";

// ------------------------------------------------------------ 平台能力的薄封装

/**
 * 洗牌的随机源。两条约束在这里撞上：
 *   1. 平台的 `nk.uuidv4()` 是一次跨 isolate 的 RPC，**返回 Promise**，必须 await；
 *   2. Fisher–Yates 要的是一个**同步**的 `random()` 回调（每次循环取一个数）。
 *
 * 解法：用一次 `uuidv4` 往返换一个 **128 位种子**，再用 xorshift128 把它展开成
 * 足够长的同步随机序列。随机性仍然来自平台（不是 `Math.random`），往返只有一次；
 * 一次洗牌要 100+ 个随机数，逐个等 RPC 会让发牌卡上几秒。
 */
async function makeRandom(nk) {
  const hex = String(await nk.uuidv4()).replace(/-/gu, "").padEnd(32, "0");
  const words = [0, 8, 16, 24].map((at) => Number.parseInt(hex.slice(at, at + 8), 16) >>> 0);
  if (words.every((word) => word === 0)) words[0] = 0x9e37_79b9;
  return () => {
    let next = words[3];
    const seed = words[0];
    words[3] = words[2];
    words[2] = words[1];
    words[1] = seed;
    next ^= next << 11;
    next >>>= 0;
    next ^= next >>> 8;
    words[0] = (next ^ seed ^ (seed >>> 19)) >>> 0;
    return words[0] / 0x1_0000_0000;
  };
}

async function readDoc(nk, ctx, key) {
  const rows = await nk.storageRead([{ collection: COLLECTION, key, userId: ctx.userId }]);
  return rows.length === 0 ? null : rows[0].value;
}

async function writeDoc(nk, ctx, key, value) {
  await nk.storageWrite([
    { collection: COLLECTION, key, userId: ctx.userId, value, permissionRead: 1, permissionWrite: 0 },
  ]);
}

/** 平台没有"只读钱包"的接口；空 changeset 的 `walletUpdate` 就是那次读。 */
async function readChips(nk, ctx) {
  const result = await nk.walletUpdate(ctx.userId, {}, {}, false);
  const updated = result.length === 0 ? null : result[0].updated;
  return updated === null || updated === undefined ? 0 : Number(updated.chips ?? 0);
}

/** 改筹码并落账本。返回改完之后的余额，供这一局的响应直接带上。 */
async function moveChips(nk, ctx, delta, metadata) {
  const result = await nk.walletUpdate(ctx.userId, { chips: delta }, metadata, true);
  const updated = result.length === 0 ? undefined : result[0].updated;
  if (updated === undefined || updated === null) throw new Error("筹码没有落库：钱包批次被回滚了");
  return Number(updated.chips ?? 0);
}

async function ledgerTail(nk, ctx, limit) {
  const page = await nk.walletLedgerList(ctx.userId, limit);
  return page.items;
}

// ------------------------------------------------------------ 桌面状态与快照

function cardView(cards) {
  return { cards, total: handValue(cards).total };
}

/** 给前端的那一份状态。暗牌在结算前只留在服务端。 */
async function snapshot(nk, ctx, extra) {
  const table = await readDoc(nk, ctx, TABLE_KEY);
  const stats = await readDoc(nk, ctx, STATS_KEY);
  const chips = await readChips(nk, ctx);
  const ledger = await ledgerTail(nk, ctx, 5);
  const reveal = table !== null && table.phase === "settled";
  return {
    chips,
    stats: stats ?? emptyStats(),
    round: table === null ? 0 : table.round,
    phase: table === null ? "idle" : table.phase,
    bet: table === null ? 0 : table.bet,
    outcome: table === null ? null : table.outcome,
    delta: table === null ? 0 : table.delta,
    player: table === null ? cardView([]) : { ...cardView(table.player), blackjack: isBlackjack(table.player) },
    dealer: visibleDealer(table === null ? [] : table.dealer, reveal),
    shoeLeft: table === null ? 0 : table.shoe.length,
    ledger,
    ...(extra ?? {}),
  };
}

/** 第一次进门：给一份开局筹码，并建一份战绩存档。 */
async function ensureProfile(nk, ctx) {
  const stats = await readDoc(nk, ctx, STATS_KEY);
  if (stats !== null) return stats;
  const fresh = emptyStats();
  await writeDoc(nk, ctx, STATS_KEY, fresh);
  await moveChips(nk, ctx, STARTING_CHIPS, { reason: "signup", note: "开局筹码" });
  return fresh;
}

/** 牌鞋见底就重洗；没见底就原样用。 */
async function nextShoe(nk, logger, previous) {
  const threshold = Math.floor(DECKS * 52 * RESHUFFLE_BELOW);
  if (previous === null) return { shoe: newShoe(DECKS, await makeRandom(nk)), reshuffled: false };
  if (previous.shoe.length >= threshold) return { shoe: previous.shoe, reshuffled: false };
  logger.info("牌鞋见底（剩 %d 张），重洗", previous.shoe.length);
  return { shoe: newShoe(DECKS, await makeRandom(nk)), reshuffled: true };
}

// ------------------------------------------------------------ RPC

/** `InitModule` 的 `nk` **故意不接**：它是"装载那一次调用"的能力对象，存下来就是坑。 */
export function InitModule(moduleCtx, logger, _nk, initializer) {
  /** 幂等：已经存在就什么都不做（`leaderboardCreate` 自己会短路）。 */
  async function ensureLeaderboard(nk) {
    // 注意 metadata 的形态：平台这一面收的是**对象**（它自己去序列化），
    // 不是上游 JS 那种"自己 stringify 好的字符串"。传错形态，平台会明确报
    // `expects metadata to be an object`。这条差异在平台的集成测试里也是这么钉的。
    await nk.leaderboardCreate(
      LEADERBOARD,
      false,
      "desc",
      "increment",
      null,
      { title: "累计净胜" },
      true,
    );
  }

  initializer.registerRpc("state", async (ctx, callLogger, nk) => {
    await ensureProfile(nk, ctx);
    return JSON.stringify(await snapshot(nk, ctx));
  });

  initializer.registerRpc("deal", async (ctx, callLogger, nk, payload) => {
    const input = payload === "" || payload === undefined ? {} : JSON.parse(payload);
    assertBet(input.bet);
    await ensureProfile(nk, ctx);
    const chips = await readChips(nk, ctx);
    if (chips < input.bet) throw new Error(`筹码不够：还剩 ${chips}，这一注要 ${input.bet}`);

    const previous = await readDoc(nk, ctx, TABLE_KEY);
    const round = previous === null ? 1 : previous.round + 1;
    const { shoe, reshuffled } = await nextShoe(nk, callLogger, previous);

    // 发牌顺序照赌场来：玩家一张、庄家一张、玩家一张、庄家暗牌。
    const player = [];
    const dealer = [];
    for (let index = 0; index < 2; index += 1) {
      player.push(shoe.pop());
      dealer.push(shoe.pop());
    }
    const table = { round, phase: "player", bet: input.bet, shoe, player, dealer, outcome: null, delta: 0 };

    await moveChips(nk, ctx, -input.bet, { reason: "bet", round });
    await ensureLeaderboard(nk);
    await writeDoc(nk, ctx, TABLE_KEY, table);
    return JSON.stringify(await snapshot(nk, ctx, { reshuffled }));
  });

  initializer.registerRpc("hit", async (ctx, callLogger, nk) => {
    const table = await readDoc(nk, ctx, TABLE_KEY);
    if (table === null || table.phase !== "player") throw new Error("现在不是你要牌的时机");
    table.player = [...table.player, table.shoe.pop()];
    if (handValue(table.player).total > 21) return settle(nk, ctx, table, true);
    await writeDoc(nk, ctx, TABLE_KEY, table);
    return JSON.stringify(await snapshot(nk, ctx));
  });

  initializer.registerRpc("stand", async (ctx, callLogger, nk) => {
    const table = await readDoc(nk, ctx, TABLE_KEY);
    if (table === null || table.phase !== "player") throw new Error("现在不是停牌的时机");
    return settle(nk, ctx, table, false);
  });

  /** 结算：庄家补牌 → 比大小 → 赔付（钱包 + 账本）→ 战绩存档 → 排行榜。 */
  async function settle(nk, ctx, table, playerBust) {
    const shoe = table.shoe.slice();
    const dealer = table.dealer.slice();
    if (!playerBust) {
      while (dealerShouldHit(dealer)) dealer.push(shoe.pop());
    }
    const { outcome, delta } = resolveRound(table.player, dealer, table.bet);
    const chips = await moveChips(nk, ctx, table.bet + delta, {
      reason: "settle",
      round: table.round,
      outcome,
    });

    const stats = (await readDoc(nk, ctx, STATS_KEY)) ?? emptyStats();
    stats.rounds += 1;
    stats.net += delta;
    stats.best = Math.max(stats.best, delta);
    if (outcome === "win") stats.wins += 1;
    else if (outcome === "blackjack") { stats.wins += 1; stats.blackjacks += 1; }
    else if (outcome === "push") stats.pushes += 1;
    else stats.losses += 1;
    await writeDoc(nk, ctx, STATS_KEY, stats);

    await nk.leaderboardRecordWrite(LEADERBOARD, ctx.userId, ctx.username, delta, 0, {
      round: table.round,
      outcome,
    });

    const settled = { ...table, shoe, dealer, phase: "settled", outcome, delta };
    await writeDoc(nk, ctx, TABLE_KEY, settled);
    return JSON.stringify(await snapshot(nk, ctx, { chips }));
  }
}
