#!/usr/bin/env python3
"""
用 OCE（OpenContextEngine）测同一批基准题的语义检索上限。

目的：量化「换成 embedding 语义检索」相对当前词法检索的实际收益，
以便在投入实现成本前先知道天花板在哪。

评分口径与 run-retrieval-eval.mjs 一致（Top-1 + nDCG@10），保证可比。

用法：
  python3 eval/oce-benchmark.py --repo <项目根> [--queries <jsonl>]
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

OCE_BASE = os.environ.get("OCE_BASE_URL", "http://127.0.0.1:8986")
OCE_KEY = os.environ.get("OCE_API_KEY", "sk-opencontextengine")

TOP_K = 10
REL_PRIMARY = 2
REL_SUPPORTING = 1


def call(path: str, payload: dict, timeout: int = 300) -> dict:
    req = urllib.request.Request(
        f"{OCE_BASE}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {OCE_KEY}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def collect_blobs(root: str, config_path: str) -> list[dict]:
    config = json.load(open(config_path, encoding="utf-8"))
    paths: set[str] = set()
    for source in config["sources"]:
        pattern = os.path.join(root, source["glob"])
        for found in glob.glob(pattern, recursive=True):
            if os.path.isfile(found):
                paths.add(os.path.relpath(found, root))
    blobs = []
    for rel in sorted(paths):
        try:
            content = open(os.path.join(root, rel), encoding="utf-8").read()
        except (OSError, UnicodeDecodeError):
            continue
        blobs.append({"path": rel.replace(os.sep, "/"), "content": content})
    return blobs


def upload(blobs: list[dict]) -> list[str]:
    """上传文档并返回 blob 标识。

    OCE 要求检索时显式声明工作集（`added_blobs` 或 `checkpoint_id`），
    不传则返回 400 SCOPE_REQUIRED。因此上传返回的标识必须保留下来，
    供后续每次检索声明范围使用。
    """
    # 分批上传，避免单请求过大。
    batch_size = 20
    names: list[str] = []
    for start in range(0, len(blobs), batch_size):
        chunk = blobs[start : start + batch_size]
        resp = call("/batch-upload", {"blobs": chunk}, timeout=600)
        names.extend(resp.get("blob_names", []))
        print(f"  已上传 {min(start + batch_size, len(blobs))}/{len(blobs)}", file=sys.stderr)
    return names


PATH_LINE = re.compile(r"`?([A-Za-z0-9_./-]+\.(?:md|yaml|yml|json))`?")


def parse_paths(text: str) -> list[str]:
    """从 OCE 的格式化结果里抽取返回的文件路径，按出现顺序。"""
    seen: list[str] = []
    for match in PATH_LINE.finditer(text or ""):
        path = match.group(1)
        if path not in seen:
            seen.append(path)
    return seen


def matches_glob(value: str, pattern: str) -> bool:
    if "*" not in pattern:
        return value == pattern
    regex = "^" + re.escape(pattern).replace(r"\*", ".*") + "$"
    return re.match(regex, value) is not None


def relevance(path: str, expected: list[str]) -> int:
    for index, pattern in enumerate(expected):
        if matches_glob(path, pattern):
            return REL_PRIMARY if index == 0 else REL_SUPPORTING
    return 0


def gain_of(returned: list[str], expected: list[str]) -> list[int]:
    claimed: set[int] = set()
    gains: list[int] = []
    for path in returned:
        for index, pattern in enumerate(expected):
            if index in claimed:
                continue
            if not matches_glob(path, pattern):
                continue
            claimed.add(index)
            gains.append(REL_PRIMARY if index == 0 else REL_SUPPORTING)
            break
    return gains


def dcg(gains: list[int]) -> float:
    import math

    return sum((2**g - 1) / math.log2(i + 2) for i, g in enumerate(gains))


def ndcg_at(returned: list[str], expected: list[str], k: int) -> float:
    import math

    ideal_gains = [(REL_PRIMARY if i == 0 else REL_SUPPORTING) for i in range(len(expected))][:k]
    ideal = dcg(ideal_gains)
    if ideal == 0:
        return 0.0
    return dcg(gain_of(returned[:k], expected)) / ideal


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument(
        "--queries",
        default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "benchmarks", "app-manager-retrieval-benchmark.jsonl"),
    )
    parser.add_argument("--skip-upload", action="store_true")
    parser.add_argument(
        "--blob-list",
        default=os.path.join(os.path.dirname(os.path.abspath(__file__)), ".oce-blobs.json"),
        help="上传标识缓存文件，避免重复上传消耗嵌入额度",
    )
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    root = os.path.abspath(args.repo)
    config_path = os.path.join(root, ".atlas", "config.json")

    blob_names: list[str] = []
    if not args.skip_upload:
        blobs = collect_blobs(root, config_path)
        print(f"上传 {len(blobs)} 个文档到 OCE …", file=sys.stderr)
        started = time.time()
        blob_names = upload(blobs)
        json.dump(blob_names, open(args.blob_list, "w", encoding="utf-8"))
        print(f"上传完成，用时 {time.time() - started:.1f}s，获得 {len(blob_names)} 个标识", file=sys.stderr)
    elif args.blob_list and os.path.exists(args.blob_list):
        blob_names = json.load(open(args.blob_list, encoding="utf-8"))
        print(f"复用 {len(blob_names)} 个已上传标识", file=sys.stderr)

    queries = [
        json.loads(line)
        for line in open(args.queries, encoding="utf-8").read().splitlines()
        if line.strip()
    ]

    rows = []
    total_ms = 0
    for item in queries:
        started = time.time()
        try:
            resp = call(
                "/agents/codebase-retrieval",
                {
                    "information_request": item["query"],
                    "blobs": {"added_blobs": blob_names},
                },
                timeout=180,
            )
            text = resp.get("formatted_retrieval", "")
            elapsed = resp.get("codebase_retrieval_elapsed_ms", 0)
            returned = parse_paths(text)
            error = None
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
            text, elapsed, returned, error = "", 0, [], str(exc)
        wall = (time.time() - started) * 1000
        total_ms += wall

        rows.append(
            {
                "id": item["id"],
                "category": item["category"],
                "difficulty": item["difficulty"],
                "query": item["query"],
                "expected": item["expected_files"],
                "returned": returned,
                "top1": bool(returned) and relevance(returned[0], item["expected_files"]) > 0,
                "ndcg": ndcg_at(returned, item["expected_files"], TOP_K),
                "elapsed_ms": elapsed,
                "wall_ms": round(wall),
                "error": error,
            }
        )
        print(f"  {item['id']} {wall:.0f}ms", file=sys.stderr)

    top1 = sum(1 for r in rows if r["top1"])
    ndcg_sum = sum(r["ndcg"] for r in rows)
    total = len(rows)
    score = top1 + ndcg_sum

    by_category: dict[str, dict] = {}
    for r in rows:
        bucket = by_category.setdefault(r["category"], {"total": 0, "top1": 0, "ndcg": 0.0})
        bucket["total"] += 1
        bucket["top1"] += 1 if r["top1"] else 0
        bucket["ndcg"] += r["ndcg"]

    summary = {
        "engine": "OCE (embedding)",
        "repo": root,
        "total": total,
        "top1": top1,
        "ndcgMean": round(ndcg_sum / total, 4) if total else 0,
        "score": round(score, 2),
        "maxScore": total * 2,
        "scoreRate": round(score / (total * 2), 4) if total else 0,
        "avgLatencyMs": round(total_ms / total) if total else 0,
        "byCategory": {
            k: {
                "total": v["total"],
                "top1": v["top1"],
                "ndcgMean": round(v["ndcg"] / v["total"], 4),
            }
            for k, v in by_category.items()
        },
        "failures": [r["id"] for r in rows if not r["top1"]],
    }

    if args.json:
        print(json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=2))
        return 0

    print()
    print(f"OCE (embedding) → {root}")
    print(f"题目 {total} | 满分 {total * 2} | 平均延迟 {summary['avgLatencyMs']}ms")
    print()
    print(f"总分 {summary['score']} / {total * 2}  ({summary['scoreRate'] * 100:.1f}%)")
    print(f"Top-1  {top1} / {total}  ({top1 / total * 100:.1f}%)")
    print(f"nDCG@10 均值 {summary['ndcgMean']}")
    print()
    print("按类别：")
    for name, value in summary["byCategory"].items():
        print(
            f"  {name:<28} Top-1 {value['top1']}/{value['total']:<5} nDCG {value['ndcgMean']:.3f}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
