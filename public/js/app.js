/**
 * 牌室的**总装**：把服务端的回答翻译成桌上的画面。
 *
 * 这里有一条只许单向的箭头：
 *
 *     玩家的动作 → /api/* → 服务端算出新状态 → 这里照着新状态重画
 *
 * 反过来永远不成立：前端**不会**自己发一张牌、不会自己算点数、不会自己决定输赢。
 * 你在这个文件里能看到"牌出现的位置"，但看不到"下一张牌是什么"——因为它不知道。
 *
 * 所以它做的事只有三类：
 *   1. 把用户意图发出去（唯一能改变世界的地方）；
 *   2. 按服务端给的状态**同步**桌面（多出来的牌才发牌动画，暗牌才翻面）；
 *   3. 把过程显示出来（HUD 文字交给 `hud.js`，牌的动画留在这里）。
 */

import { ApiError, createApi } from "./api.js";
import { createDeck } from "./cards.js";
import { createFx } from "./fx.js";
import { createHud } from "./hud.js";
import { flipTo, flyTo, place } from "./motion.js";
import { createTable } from "./table.js";
import { createTweens } from "./tween.js";

/** 界面上的下注旋钮。**它只是旋钮**：真正的校验在服务端那份规则里。 */
const STEP = 10;
const LIMITS = { min: 10, max: 500 };

/** 暗牌的替身：只用它的背面，正面永远不出现。 */
const HOLE_STAND_IN = { rank: "A", suit: "S" };

const hud = createHud();
const tweens = createTweens();
const table = createTable({ container: document.getElementById("stage") });
const deck = createDeck({ anisotropy: table.renderer.capabilities.getMaxAnisotropy() });
const fx = createFx({ scene: table.scene, tweens });
const api = createApi({ onTrace: hud.trace });

const seat = { player: [], dealer: [] };
let bet = 50;
let phase = "boot";
let busy = false;
let betChips = null;
let lastState = null;

function paint(state) {
  // 记住最后一次状态：`run()` 的 finally 要靠它把"忙完了"重新画回去。
  lastState = state;
  hud.paint(state, { bet, busy, limits: LIMITS });
}

// ------------------------------------------------------------------ 桌面同步

function retire(group) {
  tweens.add({
    duration: 220,
    onUpdate: (progress) => {
      group.scale.setScalar(Math.max(0.001, 1 - progress));
    },
    onDone: () => {
      group.removeFromParent();
    },
  });
}

/**
 * 把服务端给的一手牌同步到桌上。**只补不猜**：服务端多给了第 3 张，这里才发第 3 张。
 * 暗牌占位（`hidden > 0`）也在这条路径里：它是"服务端没给"，不是"这里藏了一张"。
 */
function syncHand(name, cards, hidden) {
  const desired = cards.map((card) => ({ card, code: `${card.rank}${card.suit}`, faceUp: true }));
  for (let index = 0; index < hidden; index += 1) desired.push({ card: null, code: null, faceUp: false });
  const slots = seat[name];
  const count = desired.length;

  desired.forEach((want, index) => {
    let slot = slots[index];
    if (slot !== undefined && slot.code !== want.code) {
      retire(slot.group);
      slots[index] = undefined;
      slot = undefined;
    }
    if (slot === undefined) {
      const group = deck.makeCard(want.card ?? HOLE_STAND_IN, { faceUp: want.faceUp });
      table.scene.add(group);
      /*
       * 起手位在牌鞋，但**朝向必须显式带上**：`place()` 会把 `rotation.z` 设成给它的角度，
       * 漏了这个参数就等于把暗牌翻成明牌——庄家的底牌会直接泄在桌上。
       */
      place(group, { ...table.positions.shoe, faceAngle: deck.faceAngle(want.faceUp) });
      slots[index] = { code: want.code, faceUp: want.faceUp, group };
      flyTo(tweens, group, table.handSlot(name, index, count), {
        delay: 60 + index * 90,
        duration: 460,
        arc: 1.5,
        spin: name === "player" ? -Math.PI * 2 : Math.PI * 2,
      });
      return;
    }
    flyTo(tweens, slot.group, table.handSlot(name, index, count), { duration: 260 });
    if (!slot.faceUp && want.faceUp) {
      slot.faceUp = true;
      flipTo(tweens, slot.group, deck.faceAngle(true), { delay: 160 });
    }
  });

  for (let index = count; index < slots.length; index += 1) {
    if (slots[index] !== undefined) retire(slots[index].group);
  }
  slots.length = count;
}

/** 结算时的**气氛**：赢了金光、输了红闪、平局金闪，外加一个飘出来的数字。 */
function celebrate(state) {
  const hand = table.positions.playerHand;
  const delta = `${state.delta > 0 ? "+" : ""}${String(state.delta)}`;
  if (state.outcome === "win" || state.outcome === "blackjack") {
    fx.burst(hand, { color: 0xffd77a, count: state.outcome === "blackjack" ? 150 : 110 });
    fx.flash(hand, 0xffd070, 70);
    fx.floatText(hand, delta, { color: "#ffe6a8" });
  } else if (state.outcome === "lose") {
    fx.flash(hand, 0xff5a4a, 60);
    fx.floatText(hand, String(state.delta), { color: "#ff9c8a" });
  } else if (state.outcome === "push") {
    fx.flash(hand, 0xc9a55f, 26);
    fx.floatText(hand, "平", { color: "#e6c283" });
  }

  // 这一注的筹码去哪：赢回自己这边、输给庄家、平局原地不动。动画自己收尾，不额外计时。
  const spent = betChips;
  betChips = null;
  if (spent !== null) {
    const target = state.outcome === "lose" ? table.positions.dealerHand : table.positions.tray;
    flyTo(tweens, spent, target, { delay: 240, duration: 520, arc: 1.1, onDone: () => { retire(spent); } });
  }
}

/** 桌面的"重画"入口：牌、筹码、数字、结果横幅都从这里走。 */
function render(state, { settle = false } = {}) {
  phase = state.phase;
  syncHand("player", state.player.cards, 0);
  syncHand("dealer", state.dealer.cards, Math.max(0, state.dealer.hidden));
  paint(state);
  if (settle) celebrate(state);
}

/** 摆下注筹码：`fly` 为真时从筹码盘飞到下注位（发牌那一刻就该看到钱出门）。 */
function placeBet(amount, { fly = false } = {}) {
  if (betChips !== null) {
    betChips.removeFromParent();
    betChips = null;
  }
  betChips = table.chips.makeStack(amount);
  table.scene.add(betChips);
  place(betChips, table.positions.tray);
  if (fly) flyTo(tweens, betChips, table.positions.betSpot, { delay: 120, duration: 560, arc: 1.0 });
}

// ------------------------------------------------------------------ 动作

async function refreshPlatformPanels() {
  const [board, ledger] = await Promise.all([api.board(), api.ledger()]);
  hud.board(board.records ?? []);
  hud.ledger(ledger.entries ?? []);
}

/** 所有动作都走这里：置忙 → 打后端 → 按新状态重画 → 解除忙（并把按钮状态补回来）。 */
async function run(work) {
  busy = true;
  hud.bootText("正在打后端…");
  try {
    await work();
    hud.link("live");
  } catch (error) {
    hud.link("error");
    // 界面只显示一句话，但控制台要留完整栈——排查时靠的是这个。
    console.error("[cardroom] 这一步被后端拒了：", error);
    hud.reject(error instanceof ApiError ? error.message : String(error.message ?? error));
  } finally {
    busy = false;
    // `paint` 在 busy 期间跑过，按钮会被算成 disabled；这一笔把"忙完了"补回去。
    if (lastState !== null) paint(lastState);
  }
}

async function boot() {
  await run(async () => {
    const who = await api.whoami();
    hud.identity(`${who.user.username} · 租户 ${String(who.tenantId).slice(0, 8)}`);
    const payload = await api.state();
    render(payload.state);
    await refreshPlatformPanels();
    hud.bootDone();
  });
}

async function act(name, payload) {
  await run(async () => {
    const previous = phase;
    const result = name === "deal" ? await api.deal(payload) : await api[name]();
    const settle = previous === "player" && result.state.phase === "settled";
    if (name === "deal") placeBet(bet, { fly: true });
    render(result.state, { settle });
    if (settle) await refreshPlatformPanels();
  });
}

hud.on("betUp", "click", () => {
  bet = Math.min(LIMITS.max, bet + STEP);
  hud.setBet(bet);
  if (betChips !== null) placeBet(bet);
});
hud.on("betDown", "click", () => {
  bet = Math.max(LIMITS.min, bet - STEP);
  hud.setBet(bet);
  if (betChips !== null) placeBet(bet);
});
hud.on("deal", "click", () => act("deal", bet));
hud.on("hit", "click", () => act("hit"));
hud.on("stand", "click", () => act("stand"));

// 画面循环：动画与粒子都挂在这一根时间轴上，帧率由浏览器决定。
table.start((dt) => {
  tweens.update(dt);
  fx.update(dt);
});

placeBet(bet);
boot().catch((error) => {
  hud.bootText(`起不来：${String(error.message ?? error)}`);
});
