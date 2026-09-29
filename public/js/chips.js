/**
 * 筹码：把"这一注 150"变成桌上看得见的一摞。
 *
 * 面额分解在 `denoms.js`（纯函数，Node 里单测）；这里只负责把面额画成圆柱。
 * 每摞筹码整体是一个 Group，于是"把筹码推到桌上"这件事就是移动一个 Group。
 */

import * as THREE from "../vendor/three.module.js";
import { chipColor, valueBreakdown } from "./denoms.js";

const CHIP_R = 0.34;
const CHIP_H = 0.075;
const CHIP_SEGMENTS = 36;

function sideTexture(denom, edge) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 32;
  const context = canvas.getContext("2d");
  context.fillStyle = edge;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "rgba(0,0,0,0.55)";
  for (let x = 0; x < canvas.width; x += 32) context.fillRect(x, 0, 16, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.repeat.set(2, 1);
  return texture;
}

export function createChips({ anisotropy = 4 } = {}) {
  const geometry = new THREE.CylinderGeometry(CHIP_R, CHIP_R, CHIP_H, CHIP_SEGMENTS);
  const materials = new Map();

  function materialsFor(denom) {
    const cached = materials.get(denom);
    if (cached !== undefined) return cached;
    const color = chipColor(denom);
    const top = new THREE.MeshStandardMaterial({ color: new THREE.Color(color.base), roughness: 0.42, metalness: 0.2 });
    const side = new THREE.MeshStandardMaterial({
      map: sideTexture(denom, color.edge),
      roughness: 0.45,
      metalness: 0.18,
    });
    const list = [side, top, top];
    materials.set(denom, list);
    return list;
  }

  /**
   * 一摞筹码。`lift` 是"这一摞要抬多高"（比如从筹码盘飞到下注位的那一下）。
   * 空金额返回一个空 Group——调用方不需要为"还没下注"写特例。
   */
  function makeStack(amount) {
    const group = new THREE.Group();
    const breakdown = valueBreakdown(amount);
    breakdown.forEach((denom, index) => {
      const mesh = new THREE.Mesh(geometry, materialsFor(denom));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.y = CHIP_H / 2 + index * CHIP_H * 0.96;
      mesh.rotation.y = (index * 0.7) % (Math.PI * 2);
      group.add(mesh);
    });
    group.userData = { amount, count: breakdown.length };
    return group;
  }

  return { makeStack, geometry, chipSize: { r: CHIP_R, h: CHIP_H }, anisotropy };
}
