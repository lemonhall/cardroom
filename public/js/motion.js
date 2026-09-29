/**
 * 三种动作，够用一整套牌桌：**飞过去**、**翻过来**、**落位**。
 *
 * 它们都只改"变换"，不碰业务：给人看的动画一旦开始，就该能被打断、能重放、
 * 而且**不改变任何状态**。所以这里没有一个函数会去读服务端的数据——数据到哪，
 * 动画就到哪，反过来绝不成立。
 */

import { EASING } from "./tween.js";

/**
 * 沿着一条抛物线把物体从 `from` 送到 `to`（起终点都是 {x,y,z}）。
 * `arc` 是抛物线中段抬高多少——发牌、推筹码靠的都是它那一点"手感"。
 */
export function flyTo(tweens, object, to, options = {}) {
  const {
    from = object.position,
    delay = 0,
    duration = 460,
    arc = 1.3,
    spin = 0,
    easing = EASING.outCubic,
    onDone,
  } = options;
  const start = { x: from.x, y: from.y, z: from.z };
  const end = { x: to.x, y: to.y, z: to.z };
  const baseTilt = object.rotation.z;
  return tweens.add({
    duration,
    delay,
    easing,
    onUpdate: (p) => {
      object.position.set(
        start.x + (end.x - start.x) * p,
        start.y + (end.y - start.y) * p + Math.sin(p * Math.PI) * arc,
        start.z + (end.z - start.z) * p,
      );
      object.rotation.z = baseTilt + spin * p;
    },
    onDone: () => {
      object.position.set(end.x, end.y, end.z);
      object.rotation.z = baseTilt + spin;
      onDone?.();
    },
  });
}

/** 翻牌：绕 Z 轴转到 `faceAngle` 那个角度，走最短的那一侧。 */
export function flipTo(tweens, object, faceAngle, options = {}) {
  const { delay = 0, duration = 280, onDone } = options;
  const start = object.rotation.z;
  let delta = (faceAngle - start) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return tweens.add({
    duration,
    delay,
    easing: EASING.inOutCubic,
    onUpdate: (p) => {
      object.rotation.z = start + delta * p;
    },
    onDone,
  });
}

/** 落位：位置与倾斜一次性给到位（没有飞行过程，用于"开局就把牌摆好"）。 */
export function place(object, { x, y, z, tilt = 0, faceAngle }) {
  object.position.set(x, y, z);
  object.rotation.z = faceAngle ?? tilt;
}
