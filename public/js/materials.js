/**
 * 桌面用到的**贴图与材质**：丝绒、皮革、金线、边缘暗角、中央徽记。
 *
 * 单独成文件是因为"好不好看"和"东西摆在哪"是两件事：
 * `table.js` 负责空间，这里负责表面。调颜色、调粗糙度、换丝绒的密度都只动这一个文件。
 *
 * 三条踩过坑的规矩：
 *   1. **贴图分两类**：可平铺的（噪点）和不可平铺的（暗角、徽记）。
 *      把暗角也拿去平铺，桌面上会出现一片片规则的暗斑，一眼假。
 *   2. **挤出几何的 UV 是世界坐标**，不是 0~1；所以要显式给 `repeat`，
 *      否则一张 512 的图会在桌上铺几十次。
 *   3. 皮革台沿**不能有太强的镜面**：一束顶光打上去会直接爆成白色一条，
 *      看上去像塑料不像皮。
 */

import * as THREE from "../vendor/three.module.js";

function canvas2d(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return { canvas, context: canvas.getContext("2d") };
}

function toTexture(canvas, { repeat = null, wrap = true } = {}) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  if (wrap) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
  }
  if (repeat !== null) texture.repeat.set(repeat[0], repeat[1]);
  return texture;
}

/** 可平铺的丝绒噪点：**没有暗角**，暗角不是噪点的职责。 */
export function velvetTexture() {
  const size = 512;
  const { canvas, context } = canvas2d(size, size);
  context.fillStyle = "#0f7a4f";
  context.fillRect(0, 0, size, size);
  for (let index = 0; index < 24000; index += 1) {
    const shade = Math.random() * 0.07;
    context.fillStyle = `rgba(255,255,255,${shade.toFixed(3)})`;
    context.fillRect(Math.random() * size, Math.random() * size, 2, 2);
  }
  for (let index = 0; index < 9000; index += 1) {
    context.fillStyle = `rgba(0,0,0,${(Math.random() * 0.05).toFixed(3)})`;
    context.fillRect(Math.random() * size, Math.random() * size, 3, 3);
  }
  // 平铺 3.2 x 2.0：太密会糊成一块纯色，太疏又能看出重复的格子。
  return toTexture(canvas, { repeat: [3.2, 2.0] });
}

/**
 * 边缘暗角：**一整张只铺一次**的半透明黑罩。
 * 有了它，桌面的绿才有中心亮、四周沉的层次；没有它，整块台呢会像一张塑料板。
 */
export function edgeShade() {
  const size = 512;
  const { canvas, context } = canvas2d(size, size);
  const gradient = context.createRadialGradient(size / 2, size / 2, size * 0.18, size / 2, size / 2, size * 0.6);
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(0.55, "rgba(0,0,0,0.10)");
  gradient.addColorStop(1, "rgba(0,0,0,0.62)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

/**
 * 桌面上方的金色徽记：印上去的一层图，不是几何体。
 * 画布是 4:1 的横向长条（`1024x256`），所以贴到 6.4 x 1.6 的平面上不会拉变形。
 */
export function brandDecal() {
  const { canvas, context } = canvas2d(1024, 256);
  context.strokeStyle = "rgba(230,194,131,0.5)";
  context.lineWidth = 4;
  context.beginPath();
  context.ellipse(canvas.width / 2, canvas.height / 2, canvas.width * 0.46, canvas.height * 0.44, 0, 0, Math.PI * 2);
  context.stroke();
  context.fillStyle = "rgba(226,190,128,0.86)";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = "600 96px Georgia, serif";
  context.fillText("CARDROOM", canvas.width / 2, canvas.height * 0.42);
  context.font = "500 34px Georgia, serif";
  context.fillText("T W E N T Y   O N E", canvas.width / 2, canvas.height * 0.72);
  return toTexture(canvas, { wrap: false });
}

/** 金色：金线、筹码盘外圈、牌鞋唇口共用的一支。`metalness` 高、`roughness` 低才像金属。 */
export function goldMaterial({ roughness = 0.3 } = {}) {
  return new THREE.MeshStandardMaterial({ color: 0xc9a55f, roughness, metalness: 0.9 });
}

/** 皮革台沿：深棕、粗糙、**只有一点点**金属度，避免顶光爆白。 */
export function leatherMaterial() {
  return new THREE.MeshStandardMaterial({ color: 0x2a1c12, roughness: 0.95, metalness: 0.02 });
}
