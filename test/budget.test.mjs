import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// 硬预算:这三条是二元的、可机器判定的,而且就是 Atlas 相对 Trellis 的立足点
// (Trellis:8 个运行时依赖 / 约 29,600 行 / 每项目 4.8 MB)。代码量只警告,不阻断 ——
// 行数是趋势指标而非约束,用它挡路只会在最需要推进时被拆掉。

const repository = path.resolve(import.meta.dirname, "..");
const cli = path.join(repository, "plugins", "atlas", "bin", "atlas.mjs");
const packageJson = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8"));

// Atlas 允许写进用户项目的全部路径。新增任何一条都必须是有意的决定,并同步改这里。
const PROJECT_SURFACE = [
  path.join(".atlas", "config.json"),
  path.join(".atlas", ".gitignore"),
  path.join(".claude", "settings.json")
];

function walk(root) {
  const found = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else found.push(path.relative(root, absolute));
    }
  };
  visit(root);
  return found.sort();
}

function freshProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-budget-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "README.md"), "# docs\n", "utf8");
  return root;
}

test("硬约束:零运行时依赖", () => {
  assert.deepEqual(
    Object.keys(packageJson.dependencies ?? {}),
    [],
    "Atlas 不得引入运行时依赖;需要新能力时先检查是不是接口选错了"
  );
});

test("硬约束:无构建步骤,发布的就是运行的源码", () => {
  assert.equal(packageJson.scripts?.build, undefined, "不得引入构建步骤");
  for (const target of Object.values(packageJson.bin ?? {})) {
    assert.ok(
      fs.existsSync(path.join(repository, target)),
      `bin 必须直接指向仓库里的源码:${target}`
    );
    assert.match(target, /\.mjs$/, "bin 应指向未编译的 .mjs 源码");
  }
});

test("硬约束:安装后项目内只出现允许清单的文件,缓存不落在项目里", () => {
  const root = freshProject();
  const before = walk(root);
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-budget-cache-"));
  const env = { ...process.env, ATLAS_CACHE_DIR: cacheDir };

  for (const args of [["init", root, "--trellis"], ["install", "--claude", root], ["index", root]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env });
    assert.equal(result.status, 0, `${args.join(" ")} 失败:${result.stderr}`);
  }

  const added = walk(root).filter((file) => !before.includes(file));
  assert.deepEqual(
    added,
    [...PROJECT_SURFACE].sort(),
    "项目内新增文件必须恰好是允许清单;意外新增意味着又造出了需要人维护的工件"
  );

  const bytes = added.reduce(
    (sum, file) => sum + fs.statSync(path.join(root, file)).size,
    0
  );
  assert.ok(bytes < 100 * 1024, `项目内足迹应远小于 100 KB,实际 ${bytes} B`);

  // 缓存必须落在项目外,否则项目足迹会随会话数增长
  assert.ok(
    fs.existsSync(path.join(cacheDir)) && walk(cacheDir).length > 0,
    "索引缓存应写入 ATLAS_CACHE_DIR"
  );
});

test("参考值:Atlas 自身代码量(只警告,不阻断)", () => {
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (absolute.endsWith(".mjs")) files.push(absolute);
    }
  };
  visit(path.join(repository, "plugins"));

  const lines = files.reduce(
    (sum, file) => sum + fs.readFileSync(file, "utf8").split("\n").length,
    0
  );
  const reference = 3000;
  const note = lines > reference ? `超出参考值 ${lines - reference} 行,需要说明理由` : "在参考值内";
  process.stdout.write(`  插件代码 ${lines} 行 / 参考 ${reference} 行 —— ${note}\n`);
  assert.ok(lines > 0);
});
