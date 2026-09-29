/**
 * `.env` 这一层的测试：解析、回写、优先级。
 *
 * 为什么值得单独测：`updateEnvFile` 是**唯一**会改这个仓库里 `.env` 的代码，而
 * `.env` 里放着 server key。它必须做到"只改我点名的那几个键，其余一个字符都不动"，
 * 并且改一百次结果都一样——否则一次 `npm run setup` 就可能把别的东西抹掉。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DEFAULTS, loadConfig, parseEnvFile, updateEnvFile } from "../src/config.mjs";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cardroom-config-"));
}

test("解析：注释与空行忽略，引号剥掉，值里的等号留着", () => {
  const parsed = parseEnvFile(
    ["# 注释", "", "A=1", "B = 'x y'", 'C="quoted"', "D=a=b", "  E=z  ", 'F=""'].join("\n"),
  );
  assert.equal(parsed.A, "1");
  assert.equal(parsed.B, "x y");
  assert.equal(parsed.C, "quoted");
  assert.equal(parsed.D, "a=b");
  assert.equal(parsed.E, "z");
  assert.equal(parsed.F, "");
  assert.equal(parsed["# 注释"], undefined);
});

test("回写：改已有的键、追加缺的键、注释与原顺序保持不变", () => {
  const file = path.join(tempDir(), ".env");
  fs.writeFileSync(file, "# 头\nA=1\n# 中间的注释\nB=2\n", "utf8");
  updateEnvFile(file, { B: "20", C: "3" });
  assert.equal(fs.readFileSync(file, "utf8"), "# 头\nA=1\n# 中间的注释\nB=20\nC=3\n");
});

test("回写幂等：同一个 patch 打一百次，文件一模一样", () => {
  const file = path.join(tempDir(), ".env");
  fs.writeFileSync(file, "A=1\n", "utf8");
  updateEnvFile(file, { A: "9", B: "8" });
  const once = fs.readFileSync(file, "utf8");
  for (let round = 0; round < 100; round += 1) updateEnvFile(file, { A: "9", B: "8" });
  assert.equal(fs.readFileSync(file, "utf8"), once);
});

test("回写：文件不存在时新建（setup 第一次跑就是这条路径）", () => {
  const file = path.join(tempDir(), ".env");
  updateEnvFile(file, { CARDROOM_TENANT_ID: "X" });
  assert.equal(fs.readFileSync(file, "utf8"), "CARDROOM_TENANT_ID=X\n");
});

test("读配置：进程环境 > .env > 默认值，且路径按仓库根解析", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, ".env"), "MUSTER_BASE=http://file:1/\nCARDROOM_PORT=6000\n", "utf8");

  const fromFile = loadConfig({ root: dir, env: {} });
  assert.equal(fromFile.musterBase, "http://file:1");
  assert.equal(fromFile.port, 6000);
  assert.equal(fromFile.moduleName, DEFAULTS.CARDROOM_MODULE);
  assert.equal(fromFile.musterDir, path.resolve(dir, DEFAULTS.MUSTER_DIR));

  const fromEnv = loadConfig({ root: dir, env: { MUSTER_BASE: "http://env:2", CARDROOM_PORT: "7000" } });
  assert.equal(fromEnv.musterBase, "http://env:2");
  assert.equal(fromEnv.port, 7000);

  const empty = loadConfig({ root: tempDir(), env: {} });
  assert.equal(empty.musterBase, DEFAULTS.MUSTER_BASE);
  assert.equal(empty.tenantId, "");
  assert.equal(empty.serverKey, "");
});
