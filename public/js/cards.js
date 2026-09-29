/**
 * 牌：把"rank + suit"这两个字母变成一张能拿起来、能翻面的三维卡片。
 *
 * 牌面不是贴图文件，是**画出来的**：每张牌第一次出现时用 2D canvas 画一张
 * 512×732 的图，之后按 `rank+suit` 缓存。这样仓库里没有一张二进制素材，
 * 换花色、换配色都只是改这里的几个常量。
 *
 * 朝向约定（后面所有动画都靠它对齐）：
 *   - 牌平躺在桌面上，长边沿 Z、短边沿 X、厚度沿 Y；
 *   - **正面是 +Y**（BoxGeometry 材质数组的 index 2），背面是 -Y（index 3）；
 *   - 翻牌 = 绕 Z 轴转 π：正面朝下，卡片看起来就是翻了个面。
 */

import * as THREE from "../vendor/three.module.js";

const SUIT_GLYPH = { S: "\u2660", H: "\u2665", D: "\u2666", C: "\u2663" };
const RED_SUITS = new Set(["H", "D"]);

const CARD_W = 1.05;
const CARD_H = 1.5;
const CARD_T = 0.016;

const FACE_BG = "#fbf7ee";
const FACE_EDGE = "#d9c9a4";
const GOLD = "#b9922f";

/** 牌面：白底、金线、角上两个点数、中间一个大花色。 */
function drawFace(context, rank, suit, width, height) {
  const glyph = SUIT_GLYPH[suit] ?? "?";
  const ink = RED_SUITS.has(suit) ? "#b7202b" : "#16181d";

  context.fillStyle = FACE_BG;
  context.fillRect(0, 0, width, height);
  const shade = context.createLinearGradient(0, 0, width, height);
  shade.addColorStop(0, "rgba(255,255,255,0.85)");
  shade.addColorStop(1, "rgba(226,214,190,0.55)");
  context.fillStyle = shade;
  context.fillRect(0, 0, width, height);

  context.strokeStyle = FACE_EDGE;
  context.lineWidth = 10;
  context.strokeRect(5, 5, width - 10, height - 10);

  // 中间那枚大花色（脸牌用金框 + 字母，靠"排版"而不是靠画人脸）。
  context.textAlign = "center";
  context.textBaseline = "middle";
  if (rank === "J" || rank === "Q" || rank === "K") {
    context.strokeStyle = GOLD;
    context.lineWidth = 6;
    context.strokeRect(width * 0.18, height * 0.2, width * 0.64, height * 0.6);
    context.fillStyle = GOLD;
    context.font = `600 ${String(Math.round(height * 0.4))}px Georgia, serif`;
    context.fillText(rank, width / 2, height * 0.46);
    context.fillStyle = ink;
    context.font = `${String(Math.round(height * 0.16))}px Georgia, serif`;
    context.fillText(glyph, width / 2, height * 0.68);
  } else {
    context.fillStyle = ink;
    context.font = `${String(Math.round(height * (rank === "A" ? 0.52 : 0.44)))}px Georgia, serif`;
    context.fillText(glyph, width / 2, height * 0.52);
  }

  // 两个角标：左上正着，右下转 180°（真牌就是这么印的）。
  const corner = (x, y, flipped) => {
    context.save();
    context.translate(x, y);
    if (flipped) context.rotate(Math.PI);
    context.fillStyle = ink;
    context.font = `600 ${String(Math.round(height * 0.14))}px Georgia, serif`;
    context.fillText(rank, 0, 0);
    context.font = `${String(Math.round(height * 0.11))}px Georgia, serif`;
    context.fillText(glyph, 0, height * 0.085);
    context.restore();
  };
  corner(width * 0.14, height * 0.12, false);
  corner(width * 0.86, height * 0.88, true);
}

/** 牌背：酒红底 + 金色菱格 + 中央一枚 "21" 徽记。 */
function drawBack(context, width, height) {
  // 背面别做得太暗：桌上光线只从一束顶光来，太暗就只剩一块黑，看不出那是张牌。
  context.fillStyle = "#6a1620";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(230,194,131,0.7)";
  context.lineWidth = 3;
  const step = width / 7;
  for (let offset = -height; offset < width + height; offset += step) {
    context.beginPath();
    context.moveTo(offset, 0);
    context.lineTo(offset + height, height);
    context.moveTo(offset, height);
    context.lineTo(offset + height, 0);
    context.stroke();
  }
  context.strokeStyle = GOLD;
  context.lineWidth = 14;
  context.strokeRect(10, 10, width - 20, height - 20);
  context.fillStyle = "rgba(20,4,8,0.72)";
  context.beginPath();
  context.ellipse(width / 2, height / 2, width * 0.34, height * 0.26, 0, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = GOLD;
  context.lineWidth = 5;
  context.stroke();
  context.fillStyle = "#e6c283";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `600 ${String(Math.round(height * 0.2))}px Georgia, serif`;
  context.fillText("21", width / 2, height / 2);
}

function canvasTexture(draw, anisotropy) {
  const width = 512;
  const height = Math.round(width * 1.43);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext("2d"), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  return texture;
}

/**
 * 造一副"牌的工厂"。材质按 `rank+suit` 缓存、几何体全校共用——
 * 一局里最多出现几十张牌，但资源只创建一次。
 */
export function createDeck({ anisotropy = 4 } = {}) {
  const geometry = new THREE.BoxGeometry(CARD_W, CARD_T, CARD_H);
  const edge = new THREE.MeshStandardMaterial({ color: 0xefe7d6, roughness: 0.65, metalness: 0.05 });
  const back = new THREE.MeshStandardMaterial({
    map: canvasTexture(drawBack, anisotropy),
    roughness: 0.5,
    metalness: 0.15,
  });
  const cache = new Map();

  function materialsFor(card) {
    const code = `${card.rank}${card.suit}`;
    const cached = cache.get(code);
    if (cached !== undefined) return cached;
    const face = new THREE.MeshStandardMaterial({
      map: canvasTexture((context, width, height) => { drawFace(context, card.rank, card.suit, width, height); }, anisotropy),
      roughness: 0.42,
      metalness: 0.06,
    });
    // BoxGeometry 的材质顺序：+X, -X, +Y, -Y, +Z, -Z。正面给 +Y，背面给 -Y。
    const list = [edge, edge, face, back, edge, edge];
    cache.set(code, list);
    return list;
  }

  /** 一张牌 = 一个 Group（Group 的旋转就是"这张牌的姿态"）。 */
  function makeCard(card, { faceUp = true } = {}) {
    const mesh = new THREE.Mesh(geometry, materialsFor(card));
    mesh.castShadow = true;
    mesh.position.y = CARD_T / 2 + 0.001;
    const group = new THREE.Group();
    group.add(mesh);
    group.userData = { card, faceUp, code: `${card.rank}${card.suit}` };
    group.rotation.z = faceUp ? 0 : Math.PI;
    return group;
  }

  /** 翻面的**目标角度**：动画自己去插值，这里只给端点。 */
  function faceAngle(faceUp) {
    return faceUp ? 0 : Math.PI;
  }

  return { makeCard, faceAngle, materialsFor, geometry, cardSize: { w: CARD_W, h: CARD_H } };
}
