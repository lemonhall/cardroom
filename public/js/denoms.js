/**
 * 筹码面额与"一堆筹码怎么摆"。
 *
 * 这是前端唯一一处**自己算数字**的地方，所以它刻意做成纯函数：
 * 服务端说的是"这一注 150"，但"用哪几个筹码堆出 150"是纯展示问题，
 * 与规则无关（换成 100+50 还是 150 个 1，赔付一分都不差）。
 *
 * 面额全是 10 的倍数，与规则里的 `BET_STEP=10` 对齐——这样贪心分解**总是**能整除，
 * 不会出现"剩 5 块没法摆"的洞。这条对齐是有意的：它把一个可能的分歧消灭在面上。
 */

export const DENOMS = [1000, 500, 100, 50, 10];

export const CHIP_COLORS = {
  10: { base: "#3f6cb0", edge: "#c9d8ee", text: "#eaf2ff" },
  50: { base: "#9c3a3a", edge: "#f0cfc4", text: "#ffe9e2" },
  100: { base: "#1f2026", edge: "#d8c98f", text: "#f6ecd2" },
  500: { base: "#5a3a92", edge: "#d5c6f2", text: "#efe7ff" },
  1000: { base: "#b9922f", edge: "#ffe9a8", text: "#fff6dd" },
};

/**
 * 把金额拆成一摞筹码的面额（从大到小）。金额必须是 10 的倍数。
 * 返回的顺序就是"从下往上"的摆放顺序：大额压底，看着稳。
 */
export function valueBreakdown(amount) {
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`筹码金额不合法：${String(amount)}`);
  if (amount % 10 !== 0) throw new Error(`筹码金额必须是 10 的倍数：${String(amount)}`);
  const out = [];
  let left = amount;
  for (const denom of DENOMS) {
    while (left >= denom) {
      out.push(denom);
      left -= denom;
    }
  }
  return out;
}

/** 面额对应的颜色；未知面额落到最低档的颜色，绝不返回 undefined。 */
export function chipColor(denom) {
  return CHIP_COLORS[denom] ?? CHIP_COLORS[10];
}
