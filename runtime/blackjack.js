/**
 * 牌室的**游戏规则本身**，作为 Muster 的运行时模块部署进平台。
 *
 * 这个文件是这份 demo 的主角：它不是跑在浏览器里，也不是跑在本地网关里，
 * 而是被平台装载进一个**独立 isolate**（`LOADER.get`），由 RPC 触发执行。
 * 浏览器只能发"意图"（下注、要牌、停牌），**牌是这里发的、分是这里算的**。
 *
 * 它刻意只用平台上真实存在的能力面（ECN-0012 的 `nk`）：
 *
 *   nk.uuidv4             → 洗牌的随机源（平台给，不用 Math.random）
 *   nk.storageRead/Write  → 牌桌状态与战绩存档（每个玩家一份文档）
 *   nk.walletUpdate       → 筹码：扣注、赔付，同时落一条账本行供对账
 *   nk.walletLedgerList   → 把最近几笔账本回给客户端（透明即信任）
 *   nk.leaderboardCreate  → 懒创建"累计净胜"榜（幂等）
 *   nk.leaderboardRecordWrite → 每局把净胜写进榜（INCREMENT 算子）
 *
 * 文件顶上那批纯函数（洗牌/点数/结算）不碰 `nk`，所以 `node --test` 可以直接
 * import 它们做单元测试——规则的正确性不必起后端才能验。
 */

export const STARTING_CHIPS = 1000;
export const MIN_BET = 10;
export const MAX_BET = 500;
export const BET_STEP = 10;
export const DECKS = 2;
/** 牌鞋剩不到这个比例就重洗：牌越少越容易被算牌。 */
const RESHUFFLE_BELOW = 0.25;

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["S", "H", "D", "C"];

const COLLECTION = "cardroom";
const TABLE_KEY = "table";
const STATS_KEY = "stats";

// ---------------------------------------------------------------- 纯规则

/** 一副 `decks` 张的牌鞋；`random` 返回 [0,1)，注入它是为了测试可复现。 */
export function newShoe(decks, random) {
  const shoe = [];
  for (let deck = 0; deck < decks; deck += 1) {
    for (const suit of SUITS) {
      for (const rank of RANKS) shoe.push({ rank, suit });
    }
  }
  return shuffle(shoe, random);
}

/** Fisher–Yates。原地洗牌会让"刚才那副牌"消失，所以返回新数组。 */
export function shuffle(cards, random) {
  const out = cards.slice();
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [out[index], out[swap]] = [out[swap], out[index]];
  }
  return out;
}

/** 单张牌的点数：A 记 11，脸牌记 10（A 的 1 点在 `handValue` 里退让）。 */
export function cardValue(card) {
  if (card.rank === "A") return 11;
  if (card.rank === "J" || card.rank === "Q" || card.rank === "K" || card.rank === "10") return 10;
  return Number(card.rank);
}

/**
 * 手牌点数。A 从 11 退到 1 是**逐张退**：总和超 21 就退一张，退完为止。
 * 返回 `soft`（手上还有一张按 11 算的 A），因为庄家"软 17 停牌"这条规则要看它。
 */
export function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    total += cardValue(card);
    if (card.rank === "A") aces += 1;
  }
  let soft = aces > 0;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
    soft = aces > 0;
  }
  return { total, soft };
}

/** 两张牌 21 点。三张凑到 21 不算 blackjack——这条差别直接决定赔率。 */
export function isBlackjack(cards) {
  return cards.length === 2 && handValue(cards).total === 21;
}

/** 庄家补牌规则：17 以上停（软 17 也停，与上游赌场惯例一致）。 */
export function dealerShouldHit(cards) {
  return handValue(cards).total < 17;
}

/**
 * 一局的净胜（筹码差）。注意赔率：blackjack 3:2，普通赢 1:1，平局 0。
 * 返回整数，因为筹码是整数——`bet` 会被校验成 10 的倍数，所以 1.5 倍也整。
 */
export function resolveRound(player, dealer, bet) {
  const playerTotal = handValue(player).total;
  const dealerTotal = handValue(dealer).total;
  const playerBlackjack = isBlackjack(player);
  const dealerBlackjack = isBlackjack(dealer);

  if (playerBlackjack && dealerBlackjack) return { outcome: "push", delta: 0 };
  if (playerBlackjack) return { outcome: "blackjack", delta: Math.floor(bet * 1.5) };
  if (playerTotal > 21) return { outcome: "lose", delta: -bet };
  if (dealerBlackjack) return { outcome: "lose", delta: -bet };
  if (dealerTotal > 21) return { outcome: "win", delta: bet };
  if (playerTotal > dealerTotal) return { outcome: "win", delta: bet };
  if (playerTotal === dealerTotal) return { outcome: "push", delta: 0 };
  return { outcome: "lose", delta: -bet };
}

export function emptyStats() {
  return { rounds: 0, wins: 0, losses: 0, pushes: 0, blackjacks: 0, net: 0, best: 0 };
}

/** 只把明牌交给客户端：暗牌在结算前必须留在服务端。 */
export function visibleDealer(dealer, reveal) {
  const cards = reveal ? dealer : dealer.slice(0, 1);
  const total = handValue(cards).total;
  return { cards, total, hidden: reveal ? 0 : dealer.length - 1 };
}

// ---------------------------------------------------------------- 平台胶水

function nkRandom(nk) {
  return () => {
    const hex = nk.uuidv4().replace(/-/gu, "").slice(0, 8);
    return Number.parseInt(hex, 16) / 0x1_0000_0000;
  };
}

async function readDoc(nk, ctx, key) {
  const rows = await nk.storageRead([
    { collection: COLLECTION, key, userId: ctx.userId },
  ]);
  return rows.length === 0 ? null : rows[0].value;
}

async function writeDoc(nk, ctx, key, value) {
  await nk.storageWrite([
    {
      collection: COLLECTION,
      key,
      userId: ctx.userId,
      value,
      permissionRead: 1,
      permissionWrite: 0,
    },
  ]);
}

/** 平台没有"只读钱包"的接口；空 changeset 的 `walletUpdate` 就是那次读。 */
async function readChips(nk, ctx) {
  const result = await nk.walletUpdate(ctx.userId, {}, {}, false);
  const updated = result.length === 0 ? null : result[0].updated;
  return updated === null || updated === undefined ? 0 : Number(updated.chips ?? 0);
}

async function moveChips(nk, ctx, delta, metadata) {
  const result = await nk.walletUpdate(ctx.userId, { chips: delta }, metadata, true);
  if (result.length === 0) throw new Error("筹码没有落库：钱包批次被回滚了");
  const updated = result[0].updated;
  if (updated === undefined) throw new Error("筹码没有落库：钱包批次被回滚了");
  return Number(updated.chips ?? 0);
}

async function ledgerTail(nk, ctx, limit) {
  const page = await nk.walletLedgerList(ctx.userId, limit);
  return page.items;
}

function assertBet(bet) {
  if (!Number.isInteger(bet)) throw new Error("下注必须是整数");
  if (bet < MIN_BET || bet > MAX_BET) throw new Error(`下注只能在 ${MIN_BET}~${MAX_BET} 之间`);
  if (bet % BET_STEP !== 0) throw new Error(`下注必须是 ${BET_STEP} 的倍数`);
}

export function InitModule(moduleCtx, logger, nk, initializer) {
  const LEADERBOARD = "cardroom-net";

  async function ensureLeaderboard() {
    // 幂等：已经存在就什么都不做（`leaderboardCreate` 自己会短路）。
    await nk.leaderboardCreate(
      LEADERBOARD,
      false,
      "desc",
      "increment",
      null,
      JSON.stringify({ title: "累计净胜" }),
      true,
    );
  }

  async function snapshot(ctx, extra) {
    const [table, stats, chips, ledger] = [
      await readDoc(nk, ctx, TABLE_KEY),
      await readDoc(nk, ctx, STATS_KEY),
      await readChips(nk, ctx),
      await ledgerTail(nk, ctx, 5),
    ];
    const reveal = table !== null && table.phase === "settled";
    return {
      chips,
      stats: stats ?? emptyStats(),
      round: table === null ? 0 : table.round,
      phase: table === null ? "idle" : table.phase,
      bet: table === null ? 0 : table.bet,
      outcome: table === null ? null : table.outcome,
      delta: table === null ? 0 : table.delta,
      player: table === null
        ? { cards: [], total: 0, blackjack: false }
        : { ...cardView(table.player), blackjack: isBlackjack(table.player) },
      dealer: visibleDealer(table === null ? [] : table.dealer, reveal),
      shoeLeft: table === null ? 0 : table.shoe.length,
      ledger,
      ...(extra ?? {}),
    };
  }

  function cardView(cards) {
    return { cards, total: handValue(cards).total };
  }

  /** 第一次进门：给一份开局筹码，并建一份战绩存档。 */
  async function ensureProfile(ctx) {
    const stats = await readDoc(nk, ctx, STATS_KEY);
    if (stats !== null) return stats;
    const fresh = emptyStats();
    await writeDoc(nk, ctx, STATS_KEY, fresh);
    await moveChips(nk, ctx, STARTING_CHIPS, { reason: "signup", note: "开局筹码" });
    return fresh;
  }

  async function draw(ctx, shoe) {
    if (shoe.length < Math.floor(DECKS * 52 * RESHUFFLE_BELOW)) {
      logger.info("牌鞋见底，重洗：%d 张", shoe.length);
      return { shoe: newShoe(DECKS, nkRandom(nk)), shuffle: true };
    }
    return { shoe, shuffle: false };
  }

  initializer.registerRpc("state", async (ctx) => {
    await ensureProfile(ctx);
    return JSON.stringify(await snapshot(ctx));
  });

  initializer.registerRpc("deal", async (ctx, _logger, _nk, payload) => {
    const input = payload === "" ? {} : JSON.parse(payload);
    assertBet(input.bet);
    await ensureProfile(ctx);
    const chips = await readChips(nk, ctx);
    if (chips < input.bet) throw new Error(`筹码不够：还剩 ${chips}，这一注要 ${input.bet}`);

    const previous = await readDoc(nk, ctx, TABLE_KEY);
    const round = previous === null ? 1 : previous.round + 1;
    const reshuffled = await draw(ctx, previous === null ? newShoe(DECKS, nkRandom(nk)) : previous.shoe);
    const shoe = reshuffled.shoe;

    // 发牌顺序照赌场来：玩家一张、庄家一张、玩家一张、庄家暗牌。
    const player = [shoe.pop(), shoe.pop()];
    const dealer = [shoe.pop(), shoe.pop()];
    const table = { round, phase: "player", bet: input.bet, shoe, player, dealer, outcome: null, delta: 0 };

    await moveChips(nk, ctx, -input.bet, { reason: "bet", round });
    await ensureLeaderboard();
    await writeDoc(nk, ctx, TABLE_KEY, table);
    return JSON.stringify(await snapshot(ctx, { reshuffled: reshuffled.shuffle }));
  });

  initializer.registerRpc("hit", async (ctx) => {
    const table = await readDoc(nk, ctx, TABLE_KEY);
    if (table === null || table.phase !== "player") throw new Error("现在不是你要牌的时机");
    table.player = [...table.player, table.shoe.pop()];
    if (handValue(table.player).total > 21) return settle(ctx, table, {}, true);
    await writeDoc(nk, ctx, TABLE_KEY, table);
    return JSON.stringify(await snapshot(ctx));
  });

  initializer.registerRpc("stand", async (ctx) => {
    const table = await readDoc(nk, ctx, TABLE_KEY);
    if (table === null || table.phase !== "player") throw new Error("现在不是停牌的时机");
    return settle(ctx, table, {}, false);
  });

  /** 结算：庄家补牌 → 比大小 → 赔付（钱包 + 账本）→ 战绩存档 → 排行榜。 */
  async function settle(ctx, table, _input, playerBust) {
    const shoe = table.shoe.slice();
    const dealer = table.dealer.slice();
    if (!playerBust) {
      while (dealerShouldHit(dealer)) dealer.push(shoe.pop());
    }
    const { outcome, delta } = resolveRound(table.player, dealer, table.bet);
    const credit = table.bet + delta;
    const chips = await moveChips(nk, ctx, credit, { reason: "settle", round: table.round, outcome });

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
    return JSON.stringify(await snapshot(ctx, { chips }));
  }
}
