/**
 * 特效：只做三件事——**金色爆发**（赢）、**红色一闪**（输）、**飘起来的数字**。
 *
 * 特效与"状态"严格分开：`app.js` 先根据服务端的回答决定发生了什么，再叫这里放一炮。
 * 所以特效永远不会"猜"结果——它没有资格猜，结果是从服务端来的。
 */

import * as THREE from "../vendor/three.module.js";
import { EASING } from "./tween.js";

/** 一粒发光的柔点，粒子与光斑共用这张贴图。 */
function glowTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.35, "rgba(255,255,255,0.55)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createFx({ scene, tweens }) {
  const glow = glowTexture();
  const group = new THREE.Group();
  scene.add(group);
  const particles = [];

  /**
   * 一炮金色粒子。`spread` 是世界单位，`ttl` 是毫秒。
   * 粒子用加法混合，所以在暗桌上看起来是"发光的碎金"。
   */
  function burst(position, { color = 0xffd77a, count = 110, spread = 3.4, ttl = 1100, size = 0.26 } = {}) {
    const geometry = new THREE.BufferGeometry();
    const points = new Float32Array(count * 3);
    const velocity = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      points[index * 3] = position.x;
      points[index * 3 + 1] = position.y + 0.1;
      points[index * 3 + 2] = position.z;
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.7 + Math.random() * spread;
      velocity[index * 3] = Math.cos(angle) * speed;
      velocity[index * 3 + 1] = 1.4 + Math.random() * 3.0;
      velocity[index * 3 + 2] = Math.sin(angle) * speed;
    }
    geometry.setAttribute("position", new THREE.BufferAttribute(points, 3));
    const material = new THREE.PointsMaterial({
      map: glow,
      color,
      size,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    const cloud = new THREE.Points(geometry, material);
    group.add(cloud);
    particles.push({ cloud, geometry, material, velocity, count, life: 0, ttl });
  }

  /** 一盏会自己熄灭的灯：赢的金光、输的红光都是它。 */
  function flash(position, color, peak = 60, duration = 620) {
    const light = new THREE.PointLight(color, 0, 14, 2);
    light.position.set(position.x, position.y + 1.6, position.z);
    group.add(light);
    tweens.add({
      duration,
      easing: EASING.outCubic,
      onUpdate: (p) => {
        light.intensity = Math.sin(p * Math.PI) * peak;
      },
      onDone: () => {
        light.removeFromParent();
      },
    });
  }

  /** 飘一个数字/单词上去（比如 `+150`）。 */
  function floatText(position, text, { color = "#e6c283", size = 96 } = {}) {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 256;
    const context = canvas.getContext("2d");
    context.fillStyle = color;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = `600 ${String(size)}px Georgia, serif`;
    context.shadowColor = "rgba(0,0,0,0.65)";
    context.shadowBlur = 18;
    context.fillText(text, canvas.width / 2, canvas.height / 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
    sprite.scale.set(2.6, 1.3, 1);
    sprite.position.set(position.x, position.y + 1.1, position.z);
    group.add(sprite);
    tweens.add({
      duration: 1500,
      easing: EASING.outCubic,
      onUpdate: (p) => {
        sprite.position.y = position.y + 1.1 + p * 1.5;
        sprite.material.opacity = p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3;
      },
      onDone: () => {
        sprite.removeFromParent();
        sprite.material.map?.dispose();
        sprite.material.dispose();
      },
    });
  }

  /** 每帧推进粒子：位置按速度走，高度受一点重力，整体随寿命淡出。 */
  function update(dt) {
    for (let index = particles.length - 1; index >= 0; index -= 1) {
      const item = particles[index];
      item.life += dt;
      const ratio = Math.min(1, item.life / item.ttl);
      const array = item.geometry.getAttribute("position").array;
      const seconds = dt / 1000;
      for (let point = 0; point < item.count; point += 1) {
        array[point * 3] += item.velocity[point * 3] * seconds;
        array[point * 3 + 1] += item.velocity[point * 3 + 1] * seconds;
        array[point * 3 + 2] += item.velocity[point * 3 + 2] * seconds;
        item.velocity[point * 3 + 1] -= 6.2 * seconds;
      }
      item.geometry.getAttribute("position").needsUpdate = true;
      item.material.opacity = 1 - ratio ** 1.6;
      if (ratio >= 1) {
        item.cloud.removeFromParent();
        item.geometry.dispose();
        item.material.dispose();
        particles.splice(index, 1);
      }
    }
  }

  return { burst, flash, floatText, update };
}
