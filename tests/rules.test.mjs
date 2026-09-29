/**
 * 规则层的单元测试。
 *
 * 为什么这些用例能在 Node 里跑：`runtime/blackjack-rules.js` 那批纯函数不碰 `nk`，
 * 洗牌的随机源是**注入**进来的。所以"牌怎么算、怎么结算"这件事的正确性，
 * 不需要起后端、不需要起网关，一条 `node --test` 就能钉住。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BET_STEP,
  DECKS,
  MAX_BET,
  MIN_BET,
  STARTING_CHIPS,
  cardValue,
  dealerShouldHit,
  emptyStats,
  handValue,
  isBlackjack,
  newShoe,
  resolveRound,
  shuffle,
  visibleDealer,
} from "../runtime/blackjack-rules.js";

/** 固定种子的线性同余：测试里每次洗牌都必须一样。 */
function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const card = (rank, suit = "S") => ({ rank, suit });

test("点数：A 从 11 退到 1 是逐张退，退完为止", () => {
  assert.equal(handValue([card("A"), card("9"), card("5")]).total, 15);
  assert.deepEqual(handValue([card("A"), card("K")]), { total: 21, soft: true });
  // 四张 A：44 → 退三张 → 14（还剩一张按 11 算），所以还是 soft。
  assert.deepEqual(handValue([card("A"), card("A"), card("A"), card("A")]), { total: 14, soft: true });
  // A + A + 9：先 21 再退一张 → 11 → soft 仍在。
  assert.deepEqual(handValue([card("A"), card("A"), card("9")]), { total: 21, soft: true });
});

test("点数：脸牌都是 10，数字牌就是数字", () => {
  assert.equal(cardValue(card("J")), 10);
  assert.equal(cardValue(card("Q")), 10);
  assert.equal(cardValue(card("K")), 10);
  assert.equal(cardValue(card("10")), 10);
  assert.equal(cardValue(card("7")), 7);
  assert.equal(cardValue(card("A")), 11);
});

test("blackjack 只认两张牌凑成的 21", () => {
  assert.equal(isBlackjack([card("A"), card("K")]), true);
  assert.equal(isBlackjack([card("7"), card("7"), card("7")]), false);
  assert.equal(isBlackjack([card("A"), card("5"), card("5")]), false);
});

test("庄家补牌：17 以上停，软 17 也停", () => {
  assert.equal(dealerShouldHit([card("10"), card("6")]), true);
  assert.equal(dealerShouldHit([card("10"), card("7")]), false);
  assert.equal(dealerShouldHit([card("A"), card("6")]), false);
  assert.equal(dealerShouldHit([card("A"), card("5")]), true);
});

test("结算：赔率与净胜逐格钉住", () => {
  // blackjack 3:2
  assert.deepEqual(resolveRound([card("A"), card("K")], [card("10"), card("9")], 100), {
    outcome: "blackjack",
    delta: 150,
  });
  // 双方都 blackjack → 平局
  assert.deepEqual(resolveRound([card("A"), card("K")], [card("A"), card("Q")], 100), {
    outcome: "push",
    delta: 0,
  });
  // 玩家爆牌
  assert.deepEqual(resolveRound([card("10"), card("6"), card("K")], [card("10"), card("9")], 100), {
    outcome: "lose",
    delta: -100,
  });
  // 庄家爆牌
  assert.deepEqual(resolveRound([card("10"), card("9")], [card("10"), card("6"), card("K")], 100), {
    outcome: "win",
    delta: 100,
  });
  // 同点
  assert.deepEqual(resolveRound([card("10"), card("9")], [card("9"), card("10")], 100), {
    outcome: "push",
    delta: 0,
  });
  // 庄家 blackjack 吃掉玩家的 20 点
  assert.deepEqual(resolveRound([card("10"), card("K")], [card("A"), card("Q")], 100), {
    outcome: "lose",
    delta: -100,
  });
});

test("牌鞋：双副牌、每张牌两份、洗牌可复现", () => {
  const shoe = newShoe(DECKS, seededRandom(7));
  assert.equal(shoe.length, DECKS * 52);
  const counts = new Map();
  for (const item of shoe) {
    const key = `${item.rank}${item.suit}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  assert.equal(counts.size, 52);
  for (const seen of counts.values()) assert.equal(seen, DECKS);

  // 同一个种子 → 同一副牌；不同种子 → 不同顺序。
  assert.deepEqual(newShoe(DECKS, seededRandom(7)), shoe);
  assert.notDeepEqual(newShoe(DECKS, seededRandom(8)), shoe);
});

test("洗牌不改原数组（原地洗会让'刚才那副牌'消失）", () => {
  const original = [card("A"), card("2"), card("3")];
  const shuffled = shuffle(original, seededRandom(3));
  assert.equal(original.length, 3);
  assert.deepEqual(original, [card("A"), card("2"), card("3")]);
  assert.deepEqual([...shuffled].sort((a, b) => a.rank.localeCompare(b.rank)), original.slice().sort((a, b) => a.rank.localeCompare(b.rank)));
});

test("暗牌：结算前只把庄家的第一张交给客户端", () => {
  const dealer = [card("10"), card("A")];
  assert.deepEqual(visibleDealer(dealer, false), { cards: [card("10")], total: 10, hidden: 1 });
  assert.deepEqual(visibleDealer(dealer, true), { cards: dealer, total: 21, hidden: 0 });
});

test("旋钮都是可解释的整数（它们是接口的一部分）", () => {
  assert.equal(STARTING_CHIPS % MIN_BET, 0);
  assert.equal(MAX_BET % BET_STEP, 0);
  assert.equal(MIN_BET % BET_STEP, 0);
  assert.deepEqual(emptyStats(), {
    rounds: 0, wins: 0, losses: 0, pushes: 0, blackjacks: 0, net: 0, best: 0,
  });
});
