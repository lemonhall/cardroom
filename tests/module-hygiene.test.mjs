/**
 * 模块源码的**静态体检**：把两类"不会报错的错误"变成红。
 *
 * 这两条都不是风格洁癖，它们各自对应一个真实的、静默的故障：
 *
 *   1. `nk.*` 是跨 isolate 的 RPC，返回 Promise。忘了 `await` 不会抛异常，
 *      你只会拿到一个 promise，然后一路算出垃圾。本项目第一版就是这么坏的：
 *      随机数全 NaN → 洗牌变成"把第二张挪到末尾" → 发牌发到 null，
 *      报错信息还停在 `Cannot read properties of null (reading 'rank')`。
 *   2. `Math.random()` 在隔离区里能跑，但它是**不可复现**的：同一副牌、同一个
 *      断言，下一次就跑不出结果。随机性必须来自平台的 `nk.uuidv4`，
 *      这样"随机从哪来"在代码里是显式的、可替换的。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const RUNTIME_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "runtime");

const sources = fs
  .readdirSync(RUNTIME_DIR)
  .filter((name) => name.endsWith(".js"))
  .map((name) => ({ name, text: fs.readFileSync(path.join(RUNTIME_DIR, name), "utf8") }));

/** 只看代码，不看注释：注释里出现 `nk.xxx()` 是正常的（本文件就写着）。 */
function codeLines(text) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.replace(/\/\/.*$/u, ""))
    .filter((line) => !/^\s*\*|^\s*\/\*/u.test(line));
}

test("runtime 目录确实有模块可查（防止这个测试自己变成空转）", () => {
  assert.ok(sources.length >= 2, `runtime/ 下应当有 blackjack.js 与 blackjack-rules.js，实际 ${String(sources.length)} 个`);
});

test("每一处 nk.* 调用都 await 了", () => {
  const offenders = [];
  for (const source of sources) {
    for (const line of codeLines(source.text)) {
      const calls = line.match(/(?<![\w.])nk\.[A-Za-z0-9_]+\(/gu) ?? [];
      if (calls.length === 0) continue;
      if (!/await\s+nk\./u.test(line)) offenders.push(`${source.name}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `这些行里的 nk.* 没有 await，会静默拿到 Promise 而不是值：\n${offenders.join("\n")}`,
  );
});

test("runtime 模块不用 Math.random（随机必须从平台来）", () => {
  const offenders = sources
    .filter((source) => codeLines(source.text).some((line) => line.includes("Math.random")))
    .map((source) => source.name);
  assert.deepEqual(offenders, [], `这些模块用了 Math.random：${offenders.join(", ")}`);
});
