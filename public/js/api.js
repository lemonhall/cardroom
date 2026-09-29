/**
 * 浏览器与后端之间**唯一**的那条缝。
 *
 * 这里没有游戏逻辑，也没有牌：它只负责把"我想发牌"翻译成一次 `POST /api/deal`，
 * 并把每次调用的形状（方法、路径、状态、耗时、上游打的哪个端点）交出去给界面显示。
 *
 * 为什么值得单独一层：整份 demo 想讲清楚的一件事就是"浏览器里没有任何权威"。
 * 把这个事实做成一个 100 行的文件，比写十页文档都有说服力——你在这里找不到
 * 一副牌、找不到点数、找不到赔率，因为那些都不住在这边。
 */

/** 每条路由的**人话名字**，用来在流水面板里解释"这一步在干嘛"。 */
const ROUTES = {
  whoami: { method: "GET", path: "/api/whoami", label: "认设备 / 换玩家令牌" },
  state: { method: "GET", path: "/api/state", label: "读桌面状态" },
  deal: { method: "POST", path: "/api/deal", label: "下注并发牌" },
  hit: { method: "POST", path: "/api/hit", label: "要一张牌" },
  stand: { method: "POST", path: "/api/stand", label: "停牌并结算" },
  board: { method: "GET", path: "/api/board", label: "读排行榜" },
  ledger: { method: "GET", path: "/api/ledger", label: "读控制台账本" },
  account: { method: "GET", path: "/api/account", label: "读账号钱包" },
};

export function createApi({ onTrace = () => {}, fetchImpl = globalThis.fetch } = {}) {
  async function call(name, body) {
    const route = ROUTES[name];
    if (route === undefined) throw new Error(`没有这条路由：${name}`);
    const started = performance.now();
    let response;
    let payload;
    try {
      response = await fetchImpl(route.path, {
        method: route.method,
        credentials: "same-origin",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      payload = await response.json();
    } catch (error) {
      onTrace({
        ...route,
        status: 0,
        ms: Math.round(performance.now() - started),
        ok: false,
        note: `连不上网关：${String(error.message ?? error)}`,
      });
      throw error;
    }
    onTrace({
      ...route,
      status: response.status,
      ms: Math.round(performance.now() - started),
      ok: response.ok && payload.ok !== false,
      // 上游真正被调用的端点在 `muster` 里，原样透出来——这是"看得见的中间发生了什么"。
      upstream: payload.muster,
      note: payload.ok === false ? String(payload.error ?? "后端拒绝了这一步") : undefined,
    });
    if (payload.ok === false) throw new ApiError(String(payload.error ?? "后端拒绝了这一步"), payload);
    return payload;
  }

  return {
    ROUTES,
    whoami: () => call("whoami"),
    state: () => call("state"),
    deal: (bet) => call("deal", { bet }),
    hit: () => call("hit", {}),
    stand: () => call("stand", {}),
    board: () => call("board"),
    ledger: () => call("ledger"),
    account: () => call("account"),
  };
}

/** 后端明确拒绝（`ok:false`）时抛这个：界面拿它展示原因，而不是"未知错误"。 */
export class ApiError extends Error {
  constructor(message, payload) {
    super(message);
    this.name = "ApiError";
    this.payload = payload;
  }
}
