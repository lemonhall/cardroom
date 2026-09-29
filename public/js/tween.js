/**
 * 一个 60 行的补间器：只做"把一个数从 0 推到 1，然后回调"。
 *
 * 为什么不用动画库：这里要的东西一共三种（发牌飞行、翻牌、筹码位移），
 * 它们的共同形状就是"进度 p ∈ [0,1] + 一个缓动 + 一次收尾回调"。多引一个库
 * 只会让"这个动画什么时候结束"变得不可见。
 *
 * 它不碰 three.js、不碰 DOM，所以可以在 Node 里直接单测（tests/tween.test.mjs）。
 */

/** 缓动都写成 p → p'，p ∈ [0,1]。 */
export const EASING = {
  linear: (p) => p,
  outCubic: (p) => 1 - (1 - p) ** 3,
  inOutCubic: (p) => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2),
  /** 发牌那种"甩出去再稳住"的手感。 */
  outBack: (p) => 1 + 2.2 * (p - 1) ** 3 + 1.2 * (p - 1) ** 2,
};

export function createTweens() {
  const running = new Set();

  /**
   * `add` 返回一个句柄：`cancel()` 能让它立刻停下（不回调 onDone）。
   * 动画被打断是常态（玩家连点、状态被覆盖），所以取消是一等公民。
   */
  function add({ duration = 300, delay = 0, easing = EASING.outCubic, onUpdate, onDone }) {
    const item = {
      duration: Math.max(1, duration),
      delay: Math.max(0, delay),
      easing,
      onUpdate,
      onDone,
      waited: 0,
      elapsed: 0,
      done: false,
    };
    running.add(item);
    return {
      cancel() {
        item.cancelled = true;
        running.delete(item);
      },
    };
  }

  /** `dt` 是毫秒。返回这一帧真正推进了几条（测试与调试用得上）。 */
  function update(dt) {
    let stepped = 0;
    for (const item of [...running]) {
      if (item.cancelled === true) continue;
      if (item.delay > 0) {
        item.waited += dt;
        if (item.waited < item.delay) continue;
        // 延迟刚好在这一帧过完：把多出来的时间算进动画，避免"延迟越久越慢"。
        item.elapsed += item.waited - item.delay;
        item.waited = item.delay;
      } else {
        item.elapsed += dt;
      }
      const raw = Math.min(1, item.elapsed / item.duration);
      item.onUpdate?.(item.easing(raw), raw);
      stepped += 1;
      if (raw >= 1) {
        item.done = true;
        running.delete(item);
        item.onDone?.();
      }
    }
    return stepped;
  }

  function clear() {
    for (const item of running) item.cancelled = true;
    running.clear();
  }

  return { add, update, clear, get size() { return running.size; } };
}
