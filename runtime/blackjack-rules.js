/**
 * 21 点的**纯规则层**：不碰 `nk`、不碰网络、不碰时间。
 *
 * 它被两个地方用：
 *   - 平台上的游戏模块（`blackjack.js`）`import` 它，跑在隔离区里；
 *   - 本地的 `node --test`（`tests/rules.test.mjs`）直接 import 它。
 *
 * 同一份规则跑在这两处，是这套 demo 里"测试套件可信"的源头：**洗牌的随机源是注入
 * 的**（不是 `Math.random`），所以"这副牌发出来该是什么结果"在测试里可以逐张钉死。
 * 规则层没有一点副作用，也就没有"测试里要起后端"这一说。
 *
 * 玩家能看见的规则全在这里：点数、A 的退位、软 17、blackjack 3:2、平局、暗牌。
 */

export const STARTING_CHIPS = 1000;
export const MIN_BET = 10;
export const MAX_BET = 500;
export const BET_STEP = 10;
export const DECKS = 2;
/** 牌鞋剩不到这个比例就重洗：牌越少越容易被算牌。 */
export const RESHUFFLE_BELOW = 0.25;

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["S", "H", "D", "C"];

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
  // 空手时不能算成 -1 张暗牌：那不是"藏了一张"，那是"还没发牌"。客户端会照着
  // `hidden` 去摆暗牌位，负数的含义只有后端自己知道，前端只能猜。
  return { cards, total, hidden: reveal ? 0 : Math.max(0, dealer.length - 1) };
}

/** 下注校验。它是规则的一部分（服务端说了算），所以不留任何"前端已经校验过"的缝。 */
export function assertBet(bet) {
  if (!Number.isInteger(bet)) throw new Error("下注必须是整数");
  if (bet < MIN_BET || bet > MAX_BET) throw new Error(`下注只能在 ${MIN_BET}~${MAX_BET} 之间`);
  if (bet % BET_STEP !== 0) throw new Error(`下注必须是 ${BET_STEP} 的倍数`);
}
