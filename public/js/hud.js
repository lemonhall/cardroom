/**
 * HUD：把服务端的状态与后端的响应**翻译成人看得懂的字**。
 *
 * 这一层只碰 DOM，不碰 WebGL、不碰牌、不发任何请求。它存在的意义是让
 * "谁在显示什么" 和 "谁在算什么" 分开：`app.js` 负责让桌上的牌动，
 * 这里负责让角落里的数字对。两者唯一的交集是一份 `state`。
 *
 * 约定：所有写入都从参数来，这里**不保存游戏状态**——`bet` 是界面上的旋钮值，
 * 它由调用方保管，因为只有调用方知道什么时候该把它交给后端。
 */

const OUTCOMES = {
  win: { label: "赢", tone: "is-win" },
  blackjack: { label: "BLACKJACK · 3:2", tone: "is-win" },
  lose: { label: "输", tone: "is-lose" },
  push: { label: "平局", tone: "is-push" },
};

const TRACE_LIMIT = 40;

export function createHud({ root = document } = {}) {
  const dom = {
    boot: root.getElementById("boot"),
    bootText: root.getElementById("boot-text"),
    linkDot: root.getElementById("link-dot"),
    identity: root.getElementById("identity-name"),
    chips: root.getElementById("stat-chips"),
    you: root.getElementById("stat-you"),
    dealer: root.getElementById("stat-dealer"),
    rounds: root.getElementById("stat-rounds"),
    record: root.getElementById("stat-record"),
    net: root.getElementById("stat-net"),
    shoe: root.getElementById("stat-shoe"),
    betValue: root.getElementById("bet-value"),
    betUp: root.getElementById("bet-up"),
    betDown: root.getElementById("bet-down"),
    betPanel: root.getElementById("bet-panel"),
    actionPanel: root.getElementById("action-panel"),
    deal: root.getElementById("deal"),
    hit: root.getElementById("hit"),
    stand: root.getElementById("stand"),
    outcomePanel: root.getElementById("outcome-panel"),
    outcomeText: root.getElementById("outcome-text"),
    outcomeDelta: root.getElementById("outcome-delta"),
    board: root.getElementById("board"),
    ledger: root.getElementById("ledger"),
    trace: root.getElementById("trace"),
  };

  /** 一次后端调用的流水：显示"这一步的方法、干了啥、花了多久"。 */
  function trace(entry) {
    const item = document.createElement("li");
    if (entry.ok !== true) item.className = "is-error";
    const upstream = entry.upstream === undefined ? "" : ` → RPC ${String(entry.upstream.path)}`;
    item.title = `${entry.label}\n${entry.method} ${entry.path}${upstream}\nHTTP ${String(entry.status)} · ${String(entry.ms)}ms`;
    item.innerHTML =
      `<span class="verb">${entry.method}</span>` +
      `<span class="what">${entry.label}${entry.note === undefined ? "" : ` · ${entry.note}`}</span>` +
      `<span class="ms">${String(entry.ms)}ms</span>`;
    dom.trace.prepend(item);
    while (dom.trace.children.length > TRACE_LIMIT) dom.trace.lastElementChild.remove();
  }

  function outcome(state) {
    const view = state.outcome === null || state.outcome === undefined ? null : OUTCOMES[state.outcome];
    if (view === null || view === undefined) {
      dom.outcomePanel.hidden = true;
      dom.outcomePanel.className = "panel outcome";
      return;
    }
    dom.outcomePanel.hidden = false;
    dom.outcomePanel.className = `panel outcome ${view.tone}`;
    dom.outcomeText.textContent = view.label;
    dom.outcomeDelta.textContent = state.delta === 0 ? "不赔不赚" : `${state.delta > 0 ? "+" : ""}${String(state.delta)}`;
  }

  /**
   * 按状态刷新整条 HUD，并**同时决定每个按钮能不能按**。
   * `bet` 与 `busy` 由调用方给：前者是旋钮值，后者是"有请求在路上"。
   */
  function paint(state, { bet, busy, limits }) {
    dom.chips.textContent = String(state.chips);
    dom.rounds.textContent = String(state.stats.rounds);
    dom.record.textContent = `${String(state.stats.wins)} / ${String(state.stats.losses)} / ${String(state.stats.pushes)}`;
    dom.net.textContent = `${state.stats.net > 0 ? "+" : ""}${String(state.stats.net)}`;
    dom.shoe.textContent = `${String(state.shoeLeft)} 张`;
    // 点数直接来自服务端（`total` 是规则算出来的，不是这里加出来的）。
    // 玩家侧：21 金色、爆牌红色。庄家侧在揭盅前只是"明牌的点数"——它本来就只有这么多。
    dom.you.textContent = state.player.cards.length === 0 ? "—" : String(state.player.total);
    dom.you.className = state.player.total > 21 ? "is-bust" : state.player.total === 21 ? "is-21" : "";
    // 庄家侧在揭盅前只是"明牌的点数"：它本来就只有这么多，多的那张还在服务端手里。
    dom.dealer.textContent = state.dealer.cards.length === 0 ? "—" : String(state.dealer.total);
    dom.betValue.textContent = String(bet);
    const betting = state.phase === "idle" || state.phase === "settled";
    const acting = state.phase === "player";
    dom.betPanel.hidden = !betting;
    dom.actionPanel.hidden = !acting;
    dom.deal.disabled = busy || !betting || state.chips < bet;
    dom.betUp.disabled = busy || !betting || bet >= limits.max;
    dom.betDown.disabled = busy || !betting || bet <= limits.min;
    dom.hit.disabled = busy || !acting;
    dom.stand.disabled = busy || !acting;
    outcome(state);
  }

  function board(records) {
    dom.board.replaceChildren();
    if (records.length === 0) {
      dom.board.innerHTML = '<li class="name">还没有人上过榜</li>';
      return;
    }
    for (const row of records) {
      const item = document.createElement("li");
      if (row.mine) item.className = "is-mine";
      item.innerHTML =
        `<span class="rank">${String(row.rank)}</span>` +
        `<span class="name">${row.username}${row.mine ? "（你）" : ""}</span>` +
        `<span class="score">${row.score > 0 ? "+" : ""}${String(row.score)}</span>`;
      dom.board.append(item);
    }
  }

  /** 账本来自**控制台通道**（server key），它是"平台的账"，不是"这一局的结果"。 */
  function ledger(entries) {
    dom.ledger.replaceChildren();
    if (entries.length === 0) {
      dom.ledger.innerHTML = '<li class="reason">还没有账本记录</li>';
      return;
    }
    for (const entry of entries) {
      const amount = Number(entry.changeset.chips ?? 0);
      const item = document.createElement("li");
      const reason = entry.metadata.reason ?? "unknown";
      const round = entry.metadata.round === undefined ? "" : ` · 第 ${String(entry.metadata.round)} 局`;
      item.innerHTML =
        `<span class="reason">${reason}${round}</span>` +
        `<span class="amount ${amount >= 0 ? "is-plus" : "is-minus"}">${amount > 0 ? "+" : ""}${String(amount)}</span>`;
      dom.ledger.append(item);
    }
  }

  return {
    trace,
    paint,
    board,
    ledger,
    setBet: (value) => {
      dom.betValue.textContent = String(value);
    },
    identity: (text) => {
      dom.identity.textContent = text;
    },
    link: (status) => {
      dom.linkDot.className = `identity__dot ${status === "live" ? "is-live" : status === "error" ? "is-error" : ""}`.trim();
    },
    bootText: (text) => {
      dom.bootText.textContent = text;
    },
    bootDone: () => {
      dom.boot.classList.add("is-done");
    },
    /** 后端明确拒绝时用的横幅：**说清是哪一步被拒的**，不留"未知错误"。 */
    reject: (reason) => {
      dom.outcomePanel.hidden = false;
      dom.outcomePanel.className = "panel outcome is-lose";
      dom.outcomeText.textContent = "这一步被后端拒了";
      dom.outcomeDelta.textContent = reason;
    },
    on: (element, event, handler) => {
      dom[element].addEventListener(event, handler);
    },
  };
}
