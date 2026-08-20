#!/usr/bin/env python3
"""Read-only Markdown inventory and link audit for Atlas."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from fnmatch import fnmatchcase
from pathlib import Path
from typing import Iterable
from urllib.parse import unquote, urlparse


DEFAULT_PATTERNS = ("*.md", "*.mdx")
EXCLUDED_PARTS = {
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "target",
    "vendor",
}
HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$")
INLINE_LINK_RE = re.compile(
    r"(?<!!)\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+(?:\"[^\"]*\"|'[^']*'))?\s*\)"
)


@dataclass(frozen=True)
class Heading:
    level: int
    text: str
    anchor: str


@dataclass(frozen=True)
class Link:
    raw_target: str
    target_path: str | None
    anchor: str | None
    external: bool


@dataclass
class Document:
    path: str
    headings: list[Heading] = field(default_factory=list)
    links: list[Link] = field(default_factory=list)
    text: str = ""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Read-only Markdown inventory and internal-link audit."
    )
    parser.add_argument("root", help="Directory to audit")
    parser.add_argument(
        "--format", choices=("markdown", "json"), default="markdown", help="Output format"
    )
    parser.add_argument(
        "--include",
        action="append",
        default=[],
        metavar="GLOB",
        help="Relative glob to include; repeatable (defaults to *.md and *.mdx)",
    )
    parser.add_argument(
        "--topic",
        action="append",
        default=[],
        metavar="TEXT",
        help="Case-insensitive topic to locate in paths, headings, or content; repeatable",
    )
    parser.add_argument("--version", action="version", version="atlas-audit 1.0.0")
    return parser.parse_args()


def is_excluded(path: Path) -> bool:
    return any(part in EXCLUDED_PARTS for part in path.parts)


def glob_variants(pattern: str) -> set[str]:
    """Let `**/` match zero directories as users expect from shell globs."""
    pending = {pattern.replace("\\", "/")}
    variants: set[str] = set()
    while pending:
        current = pending.pop()
        if current in variants:
            continue
        variants.add(current)
        marker = current.find("/**/")
        if marker >= 0:
            pending.add(current[:marker] + "/" + current[marker + 4 :])
    return variants


def matches_patterns(relative: Path, patterns: Iterable[str]) -> bool:
    candidate = relative.as_posix()
    return any(
        fnmatchcase(candidate, variant)
        for pattern in patterns
        for variant in glob_variants(pattern)
    )


def collect_markdown_files(root: Path, patterns: tuple[str, ...]) -> list[Path]:
    files: list[Path] = []
    for candidate in root.rglob("*"):
        if not candidate.is_file():
            continue
        relative = candidate.relative_to(root)
        if is_excluded(relative) or not matches_patterns(relative, patterns):
            continue
        files.append(candidate)
    return sorted(files, key=lambda path: path.as_posix().lower())


def anchor_base(text: str) -> str:
    cleaned = re.sub(r"[`*_~\[\]()]", "", text).strip().lower()
    characters: list[str] = []
    separator = False
    for char in cleaned:
        if char.isalnum() or char in "_-":
            characters.append(char)
            separator = False
        elif char.isspace() or char == "-":
            if characters and not separator:
                characters.append("-")
                separator = True
    return "".join(characters).strip("-") or "section"


def slugify_heading(text: str, used: Counter[str]) -> str:
    base = anchor_base(text)
    suffix = used[base]
    used[base] += 1
    return base if suffix == 0 else f"{base}-{suffix}"


def parse_link(raw_target: str) -> Link:
    target = unquote(raw_target.strip().strip("<>"))
    parsed = urlparse(target)
    if parsed.scheme or target.startswith("//"):
        return Link(raw_target=raw_target, target_path=None, anchor=None, external=True)
    if "#" in target:
        raw_path, raw_anchor = target.split("#", 1)
        return Link(
            raw_target=raw_target,
            target_path=raw_path or None,
            anchor=anchor_base(raw_anchor) if raw_anchor else None,
            external=False,
        )
    return Link(raw_target=raw_target, target_path=target or None, anchor=None, external=False)


def parse_document(root: Path, file_path: Path) -> Document:
    text = file_path.read_text(encoding="utf-8", errors="replace")
    used_anchors: Counter[str] = Counter()
    headings: list[Heading] = []
    for line in text.splitlines():
        match = HEADING_RE.match(line)
        if not match:
            continue
        heading_text = match.group(2).strip()
        headings.append(
            Heading(
                level=len(match.group(1)),
                text=heading_text,
                anchor=slugify_heading(heading_text, used_anchors),
            )
        )
    links = [parse_link(match.group(1)) for match in INLINE_LINK_RE.finditer(text)]
    return Document(
        path=file_path.relative_to(root).as_posix(), headings=headings, links=links, text=text
    )


def resolve_target(root: Path, source: Document, target_path: str | None) -> str | None:
    if not target_path:
        return source.path
    candidate = (root / source.path).parent / target_path
    try:
        resolved = candidate.resolve(strict=False)
        resolved.relative_to(root.resolve())
    except ValueError:
        return None
    if not resolved.exists() or not resolved.is_file():
        return ""
    return resolved.relative_to(root).as_posix()


def document_payload(document: Document, inbound_count: int) -> dict[str, object]:
    return {
        "path": document.path,
        "headings": [heading.__dict__ for heading in document.headings],
        "internal_link_count": sum(not link.external for link in document.links),
        "external_link_count": sum(link.external for link in document.links),
        "inbound_link_count": inbound_count,
    }


def build_report(root: Path, documents: list[Document], topics: list[str]) -> dict[str, object]:
    by_path = {document.path: document for document in documents}
    inbound: Counter[str] = Counter()
    link_issues: list[dict[str, str]] = []
    heading_locations: defaultdict[str, list[dict[str, str]]] = defaultdict(list)

    for document in documents:
        for heading in document.headings:
            normalized = re.sub(r"\s+", " ", heading.text.strip().lower())
            heading_locations[normalized].append(
                {"path": document.path, "heading": heading.text, "anchor": heading.anchor}
            )

        for link in document.links:
            if link.external:
                continue
            resolved = resolve_target(root, document, link.target_path)
            if resolved is None:
                link_issues.append(
                    {
                        "kind": "outside_root",
                        "source": document.path,
                        "target": link.raw_target,
                    }
                )
                continue
            if resolved == "":
                link_issues.append(
                    {
                        "kind": "missing_file",
                        "source": document.path,
                        "target": link.raw_target,
                    }
                )
                continue
            inbound[resolved] += 1
            target_document = by_path.get(resolved)
            if link.anchor and target_document:
                anchors = {heading.anchor for heading in target_document.headings}
                if link.anchor not in anchors:
                    link_issues.append(
                        {
                            "kind": "missing_anchor",
                            "source": document.path,
                            "target": link.raw_target,
                        }
                    )
            elif link.anchor and not target_document:
                link_issues.append(
                    {
                        "kind": "unverified_anchor_target",
                        "source": document.path,
                        "target": link.raw_target,
                    }
                )

    duplicate_headings = [
        {"normalized_heading": key, "locations": locations}
        for key, locations in sorted(heading_locations.items())
        if len({location["path"] for location in locations}) > 1
    ]
    orphan_candidates = [
        document.path
        for document in documents
        if inbound[document.path] == 0
        and Path(document.path).name.lower() not in {"readme.md", "readme.mdx", "index.md", "index.mdx"}
    ]
    topic_matches: dict[str, list[str]] = {}
    for topic in topics:
        needle = topic.casefold()
        topic_matches[topic] = [
            document.path
            for document in documents
            if needle in document.path.casefold()
            or needle in document.text.casefold()
            or any(needle in heading.text.casefold() for heading in document.headings)
        ]

    return {
        "schema_version": 1,
        "root": str(root),
        "summary": {
            "markdown_file_count": len(documents),
            "link_issue_count": len(link_issues),
            "duplicate_heading_group_count": len(duplicate_headings),
            "orphan_candidate_count": len(orphan_candidates),
        },
        "documents": [document_payload(document, inbound[document.path]) for document in documents],
        "link_issues": link_issues,
        "duplicate_heading_groups": duplicate_headings,
        "orphan_candidates": orphan_candidates,
        "topic_matches": topic_matches,
        "limitations": [
            "Findings are advisory; Atlas does not infer business truth or deletion safety.",
            "Only inline relative Markdown links and ATX headings are checked.",
            "External URLs and unsupported Markdown syntax are not validated.",
        ],
    }


def markdown_report(report: dict[str, object]) -> str:
    summary = report["summary"]
    assert isinstance(summary, dict)
    lines = [
        "# Atlas Audit",
        "",
        f"Root: `{report['root']}`",
        "",
        "## Summary",
        "",
        f"- Markdown files: {summary['markdown_file_count']}",
        f"- Internal-link issues: {summary['link_issue_count']}",
        f"- Duplicate heading groups: {summary['duplicate_heading_group_count']}",
        f"- Candidate orphan pages: {summary['orphan_candidate_count']}",
        "",
        "## Link issues",
        "",
    ]
    link_issues = report["link_issues"]
    assert isinstance(link_issues, list)
    lines.extend(
        [f"- `{issue['kind']}` — `{issue['source']}` → `{issue['target']}`" for issue in link_issues]
        or ["- None"]
    )
    lines.extend(["", "## Candidate orphan pages", ""])
    orphan_candidates = report["orphan_candidates"]
    assert isinstance(orphan_candidates, list)
    lines.extend([f"- `{path}`" for path in orphan_candidates] or ["- None"])
    lines.extend(["", "## Duplicate heading groups", ""])
    duplicate_groups = report["duplicate_heading_groups"]
    assert isinstance(duplicate_groups, list)
    if duplicate_groups:
        for group in duplicate_groups:
            lines.append(f"- `{group['normalized_heading']}`")
            lines.extend(
                [f"  - `{location['path']}` → `{location['heading']}`" for location in group["locations"]]
            )
    else:
        lines.append("- None")
    topic_matches = report["topic_matches"]
    assert isinstance(topic_matches, dict)
    if topic_matches:
        lines.extend(["", "## Topic matches", ""])
        for topic, matches in topic_matches.items():
            lines.append(f"### {topic}")
            lines.extend([f"- `{path}`" for path in matches] or ["- None"])
            lines.append("")
    lines.extend(["## Limits", ""])
    limitations = report["limitations"]
    assert isinstance(limitations, list)
    lines.extend([f"- {item}" for item in limitations])
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    args = parse_args()
    root = Path(args.root).expanduser().resolve()
    if not root.is_dir():
        print(f"atlas-audit: root is not a directory: {root}", file=sys.stderr)
        return 2
    patterns = tuple(args.include) if args.include else DEFAULT_PATTERNS
    documents = [parse_document(root, path) for path in collect_markdown_files(root, patterns)]
    report = build_report(root, documents, args.topic)
    if args.format == "json":
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(markdown_report(report), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
