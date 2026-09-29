/**
 * 牌桌本身：世界、光、丝绒、金线、以及"东西该放在哪"。
 *
 * 这个文件回答的是**空间问题**：桌子多大、相机站哪、牌鞋在哪、发牌飞到哪。
 * 它不知道游戏规则，也不发起任何请求——把 `positions` 交出去，剩下的交给 app.js。
 *
 * 视觉上的三个决定：
 *   1. 只有**一束暖光**（加上两盏很弱的轮廓光），其余全黑——赌桌的舞台感来自对比，
 *      不是来自亮；
 *   2. 桌面材质是画出来的丝绒（噪点 + 中心暗角），所以远看是绿的、近看有绒；
 *   3. 金只出现在边缘与中央徽记上，和 HUD 的配色是同一套。
 */

import * as THREE from "../vendor/three.module.js";
import { createChips } from "./chips.js";
import { brandDecal, edgeShade, goldMaterial, leatherMaterial, velvetTexture } from "./materials.js";

const TABLE_W = 11.8;
const TABLE_D = 7.0;
/** 丝绒台面的上表面。所有"桌上的东西"都从这个高度往上摆。 */
const FELT_TOP = 0.26;
/** 相机的家。构图要能让整张桌子（含金边）连同一点余量一起进画面——桌角被切掉就不像赌桌了。 */
const CAMERA_HOME = { x: 0, y: 11.4, z: 13.6, lookZ: -0.85 };

/** 圆角矩形（挤出用），宽高是"整块"，圆角给到像张牌桌。 */
function roundedRect(width, depth, radius) {
  const x = width / 2;
  const z = depth / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-x + radius, -z);
  shape.lineTo(x - radius, -z);
  shape.quadraticCurveTo(x, -z, x, -z + radius);
  shape.lineTo(x, z - radius);
  shape.quadraticCurveTo(x, z, x - radius, z);
  shape.lineTo(-x + radius, z);
  shape.quadraticCurveTo(-x, z, -x, z - radius);
  shape.lineTo(-x, -z + radius);
  shape.quadraticCurveTo(-x, -z, -x + radius, -z);
  return shape;
}

/**
 * 挤出一块板。`uvSpan` 给的是这块板的尺寸——**必须给**，因为 ExtrudeGeometry 生成的
 * UV 直接是形状的世界坐标（不是 0~1），不归一化的话一张 512 的贴图会在桌面上平铺
 * 几十次，噪点和暗角互相叠加，整块丝绒会被压成一片橄榄褐（第一版就是这么翻车的）。
 */
function hexTurned(shape, depth, material, uvSpan = null) {
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  if (uvSpan !== null) {
    const uv = geometry.getAttribute("uv");
    for (let index = 0; index < uv.count; index += 1) {
      uv.setXY(index, uv.getX(index) / uvSpan.w + 0.5, uv.getY(index) / uvSpan.d + 0.5);
    }
    uv.needsUpdate = true;
  }
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  return mesh;
}

/** 带洞的框架：桌沿与金线都是"框"，不是"板"。实心板会把整张桌面盖住。 */
function frame(outerShape, innerShape) {
  outerShape.holes.push(new THREE.Path(innerShape.getPoints(64)));
  return outerShape;
}

export function createTable({ container, anisotropy = 8 } = {}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05060a);
  scene.fog = new THREE.Fog(0x05060a, 16, 34);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.append(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 120);
  camera.position.set(CAMERA_HOME.x, CAMERA_HOME.y, CAMERA_HOME.z);
  camera.lookAt(0, 0, CAMERA_HOME.lookZ);

  // 光：一束暖主光 + 两盏很弱的金轮廓 + 一点冷补光（背景别死黑）。
  scene.add(new THREE.AmbientLight(0x54617a, 0.42));
  // 主光偏"日光白"而不是烛光黄：黄光会把绿绒压成橄榄色（第一版就是这么偏的）。
  // 强度要克制：顶光一旦过曝，台沿会变成一条白线，桌上的牌反而看不清。
  const key = new THREE.SpotLight(0xfff1dc, 300, 0, 0.86, 0.86, 2);
  key.position.set(0, 9.4, 3.8);
  key.target.position.set(0, 0, -0.7);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 3;
  key.shadow.camera.far = 22;
  key.shadow.bias = -0.0006;
  key.shadow.radius = 2.5;
  scene.add(key, key.target);
  for (const side of [-1, 1]) {
    const rim = new THREE.PointLight(0xffa855, 30, 26, 2);
    rim.position.set(side * 6.2, 2.2, 3.8);
    scene.add(rim);
  }
  const fill = new THREE.PointLight(0x4a6cff, 22, 34, 2);
  fill.position.set(0, 4.2, -8);
  scene.add(fill);

  // 桌体三层：外圈金线（比丝绒高一点，形成一道"唇"）、皮包边、内圈丝绒。
  const trim = hexTurned(
    frame(roundedRect(TABLE_W + 1.1, TABLE_D + 1.1, 1.95), roundedRect(TABLE_W + 0.78, TABLE_D + 0.78, 1.7)),
    0.3,
    goldMaterial({ roughness: 0.26 }),
  );
  scene.add(trim);

  const rail = hexTurned(
    frame(roundedRect(TABLE_W + 0.9, TABLE_D + 0.9, 1.8), roundedRect(TABLE_W, TABLE_D, 1.55)),
    0.24,
    leatherMaterial(),
  );
  scene.add(rail);

  const felt = hexTurned(
    roundedRect(TABLE_W, TABLE_D, 1.55),
    FELT_TOP,
    new THREE.MeshStandardMaterial({ map: velvetTexture(), roughness: 0.96, metalness: 0 }),
    { w: TABLE_W, d: TABLE_D },
  );
  scene.add(felt);

  // 边缘暗角：整张只铺一次的半透明黑罩，压在台呢上方 3 毫米。
  const shade = new THREE.Mesh(
    new THREE.PlaneGeometry(TABLE_W, TABLE_D),
    new THREE.MeshBasicMaterial({ map: edgeShade(), transparent: true, depthWrite: false }),
  );
  shade.rotation.x = -Math.PI / 2;
  shade.position.set(0, FELT_TOP + 0.003, 0);
  scene.add(shade);

  const decal = new THREE.Mesh(
    new THREE.PlaneGeometry(6.4, 1.6),
    new THREE.MeshBasicMaterial({ map: brandDecal(), transparent: true, depthWrite: false }),
  );
  decal.rotation.x = -Math.PI / 2;
  decal.position.set(0, FELT_TOP + 0.005, -2.5);
  scene.add(decal);

  // 下注位：一圈金线。
  const betRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.75, 0.026, 12, 72),
    goldMaterial({ roughness: 0.32 }),
  );
  betRing.rotation.x = -Math.PI / 2;
  betRing.position.set(0, FELT_TOP + 0.006, 2.5);
  scene.add(betRing);

  // 牌鞋：发牌的起点。深色盒 + 金唇 + 露在外面的**一叠牌**，一眼能看出"牌从这里出来"。
  const shoe = new THREE.Group();
  const shoeBody = new THREE.Mesh(
    new THREE.BoxGeometry(1.15, 0.46, 1.5),
    new THREE.MeshStandardMaterial({ color: 0x1a1512, roughness: 0.62, metalness: 0.18 }),
  );
  shoeBody.position.y = 0.23;
  shoeBody.castShadow = true;
  const shoeLip = new THREE.Mesh(
    new THREE.BoxGeometry(1.02, 0.05, 1.36),
    goldMaterial({ roughness: 0.34 }),
  );
  shoeLip.position.y = 0.47;
  // 鞋里那一叠牌：只有这一小片白，是"牌鞋"和"一块木头"的区别。
  const shoeDeck = new THREE.Mesh(
    new THREE.BoxGeometry(0.86, 0.2, 1.28),
    new THREE.MeshStandardMaterial({ color: 0xf2ece2, roughness: 0.85, metalness: 0 }),
  );
  shoeDeck.position.y = 0.58;
  shoe.add(shoeBody, shoeLip, shoeDeck);
  shoe.position.set(4.65, FELT_TOP, -1.7);
  shoe.rotation.y = -0.34;
  scene.add(shoe);

  const chips = createChips({ anisotropy });
  /** 玩家筹码盘：视觉上"钱是从这里出去的"。 */
  const tray = new THREE.Mesh(
    new THREE.CylinderGeometry(0.72, 0.6, 0.14, 40),
    new THREE.MeshStandardMaterial({ color: 0x14251c, roughness: 0.7, metalness: 0.2 }),
  );
  tray.position.set(4.9, FELT_TOP + 0.07, 2.3);
  tray.receiveShadow = true;
  scene.add(tray);

  const positions = {
    feltTop: FELT_TOP,
    shoe: { x: shoe.position.x - 0.55, y: FELT_TOP + 0.7, z: shoe.position.z },
    tray: { x: tray.position.x, y: FELT_TOP + 0.14, z: tray.position.z },
    betSpot: { x: betRing.position.x, y: FELT_TOP + 0.02, z: betRing.position.z },
    dealerHand: { x: 0, y: FELT_TOP + 0.01, z: -0.95 },
    playerHand: { x: 0, y: FELT_TOP + 0.01, z: 0.95 },
    discard: { x: -4.6, y: FELT_TOP + 0.01, z: -1.8 },
  };

  /**
   * 一张牌在手里的位置：`index` 从 0 开始，整体居中，间隔带一点扇开。
   *
   * 座位名（`player` / `dealer`）是**游戏**的说法，`positions` 里的键（`playerHand` /
   * `dealerHand`）是**空间**的说法，两者在这里对表。之前这里直接拿座位名去查 `positions`，
   * 结果一走到"手上真有牌"的分支就炸（空手时不炸，所以启动看不出问题）。
   */
  const HAND_ANCHOR = { player: "playerHand", dealer: "dealerHand" };
  function handSlot(seat, index, count) {
    const base = positions[HAND_ANCHOR[seat]];
    const step = 0.62;
    const offset = (index - (count - 1) / 2) * step;
    return { x: base.x + offset, y: base.y + index * 0.004, z: base.z + Math.abs(offset) * 0.06 };
  }

  // 注意：这里不能叫 `frame`——模块顶层的 `frame()` 形状函数会被同名变量遮蔽成 TDZ。
  let rafId = null;
  function start(onFrame) {
    const clock = new THREE.Clock();
    let elapsed = 0;
    const tick = () => {
      const dt = Math.min(64, clock.getDelta() * 1000);
      elapsed += dt;
      // 相机极缓地摆：牌桌是"活的"，但绝不该让人注意到它在动。
      camera.position.x = CAMERA_HOME.x + Math.sin(elapsed * 0.00013) * 0.5;
      camera.position.y = CAMERA_HOME.y + Math.sin(elapsed * 0.00021) * 0.14;
      camera.position.z = CAMERA_HOME.z + Math.cos(elapsed * 0.00017) * 0.24;
      camera.lookAt(0, 0, CAMERA_HOME.lookZ);
      onFrame(dt, elapsed);
      renderer.render(scene, camera);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }

  function resize() {
    const width = container.clientWidth || globalThis.innerWidth;
    const height = container.clientHeight || globalThis.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  }

  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  return { THREE, scene, camera, renderer, positions, handSlot, chips, start, resize, FELT_TOP };
}
