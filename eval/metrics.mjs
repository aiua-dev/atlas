// 两条检索路径共用评分口径。每个返回位置都参与折扣，未命中与重复项增益为 0。
function matchesGlob(value, pattern) {
  if (!pattern.includes("*")) return value === pattern;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

export function top1Hit(results, expectedFiles) {
  return results.length > 0 && expectedFiles.some((pattern) => matchesGlob(results[0].path, pattern));
}

function dcg(gains) {
  return gains.reduce((sum, gain, index) => sum + (2 ** gain - 1) / Math.log2(index + 2), 0);
}

export function ndcgAt(results, expectedFiles, k) {
  const ideal = dcg(expectedFiles.slice(0, k).map((_, index) => index === 0 ? 2 : 1));
  if (ideal === 0) return 0;
  const claimed = new Set();
  const seenPaths = new Set();
  const gains = results.slice(0, k).map(({ path }) => {
    if (seenPaths.has(path)) return 0;
    seenPaths.add(path);
    const index = expectedFiles.findIndex((pattern, i) => !claimed.has(i) && matchesGlob(path, pattern));
    if (index < 0) return 0;
    claimed.add(index);
    return index === 0 ? 2 : 1;
  });
  return dcg(gains) / ideal;
}
