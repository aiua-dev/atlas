import fs from "node:fs";
import path from "node:path";

// Resolve both textual traversal and symlinks before any canonical-source write.
export function resolveOwnerPath(root, owner) {
  const within = (base, file) => {
    const relative = path.relative(base, file);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const full = path.resolve(root, owner);
  if (!within(path.resolve(root), full)) throw new Error(`归属路径必须位于项目内：${owner}`);
  if (!fs.existsSync(full)) throw new Error(`归属文件不存在：${owner}`);
  const realRoot = fs.realpathSync(root);
  const realFile = fs.realpathSync(full);
  if (!within(realRoot, realFile) || !fs.statSync(realFile).isFile()) {
    throw new Error(`归属路径必须位于项目内且是普通文件：${owner}`);
  }
  return path.relative(realRoot, realFile).split(path.sep).join("/");
}
