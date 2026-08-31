import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_RELATIVE_PATH = path.join(".atlas", "config.json");
const INDEX_VERSION = 1;
const DEFAULT_LIMITS = {
  maxResults: 6,
  maxRelated: 2,
  maxContextChars: 6000,
  maxBodyTerms: 12000
};

const DEFAULT_CONFIG = {
  version: 1,
  entrypoints: ["AGENTS.md", "CONTEXT.md", "README.md", "docs/README.md"],
  sources: [
    { glob: "docs/**/*.md", role: "canonical-doc", authority: 90 },
    { glob: "docs/**/*.yaml", role: "api-contract", authority: 95 },
    { glob: "docs/**/*.yml", role: "api-contract", authority: 95 },
    { glob: ".trellis/spec/**/*.md", role: "implementation-constraint", authority: 55 },
    { glob: ".trellis/tasks/*/prd.md", role: "task-intent", authority: 35 },
    { glob: ".trellis/tasks/*/design.md", role: "task-intent", authority: 35 },
    { glob: ".trellis/tasks/*/implement.md", role: "task-evidence", authority: 25 }
  ],
  exclude: [
    ".git/**",
    "node_modules/**",
    ".trellis/.runtime/**",
    ".trellis/tasks/archive/**"
  ],
  routes: [],
  limits: DEFAULT_LIMITS
};

function posixRelative(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

function normalizeText(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase();
}

function tokenize(value) {
  const normalized = normalizeText(value);
  const result = new Set();
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9_.:/-]*|\p{Script=Han}+/gu)) {
    const token = match[0];
    if (/^\p{Script=Han}+$/u.test(token)) {
      if (token.length <= 16) result.add(token);
      for (let size = 2; size <= Math.min(3, token.length); size += 1) {
        for (let i = 0; i <= token.length - size; i += 1) {
          result.add(token.slice(i, i + size));
        }
      }
    } else if (token.length >= 2 || token === "id") {
      result.add(token);
      for (const part of token.split(/[._:/-]+/)) {
        if (part.length >= 2 || part === "id") result.add(part);
      }
    }
  }
  return [...result];
}

function globToRegExp(glob) {
  const source = String(glob).split(path.sep).join("/");
  let pattern = "^";
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === "*") {
      if (source[i + 1] === "*") {
        i += 1;
        if (source[i + 1] === "/") {
          i += 1;
          pattern += "(?:.*/)?";
        } else {
          pattern += ".*";
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${pattern}$`);
}

function staticGlobBase(glob) {
  const normalized = String(glob).split(path.sep).join("/");
  const wildcard = normalized.search(/[?*[]/);
  const prefix = wildcard < 0 ? normalized : normalized.slice(0, wildcard);
  const base = prefix.endsWith("/") ? prefix.slice(0, -1) : path.posix.dirname(prefix);
  return base === "." ? "" : base;
}

function mergeConfig(raw) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    entrypoints: Array.isArray(raw.entrypoints) ? raw.entrypoints : DEFAULT_CONFIG.entrypoints,
    sources: Array.isArray(raw.sources) ? raw.sources : DEFAULT_CONFIG.sources,
    exclude: Array.isArray(raw.exclude) ? raw.exclude : DEFAULT_CONFIG.exclude,
    routes: Array.isArray(raw.routes) ? raw.routes : [],
    limits: { ...DEFAULT_LIMITS, ...(raw.limits ?? {}) }
  };
}

export function findProjectRoot(start = process.cwd()) {
  let current = path.resolve(start);
  if (fs.existsSync(current) && fs.statSync(current).isFile()) current = path.dirname(current);
  while (true) {
    if (fs.existsSync(path.join(current, CONFIG_RELATIVE_PATH))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function loadProject(projectRoot) {
  const root = path.resolve(projectRoot);
  const configPath = path.join(root, CONFIG_RELATIVE_PATH);
  if (!fs.existsSync(configPath)) {
    throw new Error(`未找到 Atlas 配置：${configPath}`);
  }
  const raw = readJson(configPath);
  if (raw.version !== 1) throw new Error(`不支持 Atlas 配置版本：${raw.version}`);
  return { root, configPath, config: mergeConfig(raw), rawConfig: raw };
}

export function cachePathFor(projectRoot) {
  const base = process.env.ATLAS_CACHE_DIR
    ? path.resolve(process.env.ATLAS_CACHE_DIR)
    : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "atlas-context-router");
  const key = sha256(fs.realpathSync(projectRoot)).slice(0, 20);
  return path.join(base, key, "index.json");
}

function sourceMatcher(config) {
  const sources = config.sources.map((source) => ({
    ...source,
    regex: globToRegExp(source.glob)
  }));
  return (relative) => {
    const source = sources.find((candidate) => candidate.regex.test(relative));
    if (source) return source;
    if (config.entrypoints.includes(relative)) {
      return { glob: relative, role: "knowledge-entrypoint", authority: 100 };
    }
    return null;
  };
}

function collectFiles(root, config) {
  const excluded = config.exclude.map(globToRegExp);
  const matchesSource = sourceMatcher(config);
  const files = new Map();
  const roots = new Set();

  for (const entry of config.entrypoints) {
    const absolute = path.join(root, entry);
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) files.set(entry, matchesSource(entry));
  }
  for (const source of config.sources) {
    const base = staticGlobBase(source.glob);
    const absolute = path.join(root, base);
    if (!fs.existsSync(absolute)) continue;
    if (fs.statSync(absolute).isFile()) {
      const relative = posixRelative(root, absolute);
      if (globToRegExp(source.glob).test(relative)) files.set(relative, source);
    } else {
      roots.add(absolute);
    }
  }

  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = posixRelative(root, absolute);
      if (excluded.some((regex) => regex.test(relative) || regex.test(`${relative}/`))) continue;
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        const source = matchesSource(relative);
        if (source) files.set(relative, source);
      }
    }
  }
  for (const directory of roots) walk(directory);
  return [...files.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function slugifyHeading(value) {
  return normalizeText(value)
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{Letter}\p{Number}\p{Script=Han}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

function parseMarkdownLinks(text, root, relativePath) {
  const links = [];
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1];
    if (/^(?:[a-z]+:|#)/i.test(href)) continue;
    const [pathname, anchor = ""] = href.split("#", 2);
    const decoded = decodeURIComponent(pathname);
    const absolute = path.resolve(root, path.dirname(relativePath), decoded);
    if (!absolute.startsWith(`${root}${path.sep}`) && absolute !== root) continue;
    links.push({ path: posixRelative(root, absolute), anchor });
  }
  return links;
}

function parseDocument(root, relative, source, text, stat, maxBodyTerms) {
  const isMarkdown = /\.md$/i.test(relative);
  const lines = text.split(/\r?\n/);
  const headings = [];
  if (isMarkdown) {
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (match) headings.push({ level: match[1].length, title: match[2], line: index + 1 });
    }
    for (let index = 0; index < headings.length; index += 1) {
      const current = headings[index];
      const next = headings.slice(index + 1).find((item) => item.level <= current.level);
      current.endLine = next ? next.line - 1 : lines.length;
      current.anchor = slugifyHeading(current.title);
    }
  }
  const title = headings.find((heading) => heading.level === 1)?.title || path.basename(relative);
  const keyText = `${relative}\n${title}\n${headings.map((heading) => heading.title).join("\n")}`;
  return {
    path: relative,
    role: source.role || "reference",
    authority: Number(source.authority ?? 50),
    sourceGlob: source.glob,
    title,
    headings,
    links: isMarkdown ? parseMarkdownLinks(text, root, relative) : [],
    keyTerms: tokenize(keyText),
    bodyTerms: tokenize(text).slice(0, maxBodyTerms),
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
}

export function buildIndex(projectRoot) {
  const project = loadProject(projectRoot);
  const configText = fs.readFileSync(project.configPath, "utf8");
  const configHash = sha256(configText);
  const cachePath = cachePathFor(project.root);
  let previous = null;
  if (fs.existsSync(cachePath)) {
    try {
      const parsed = readJson(cachePath);
      if (parsed.indexVersion === INDEX_VERSION && parsed.root === project.root && parsed.configHash === configHash) {
        previous = parsed;
      }
    } catch {
      previous = null;
    }
  }
  const previousByPath = new Map((previous?.documents ?? []).map((document) => [document.path, document]));
  const documents = [];
  let readCount = 0;
  let reusedCount = 0;
  for (const [relative, source] of collectFiles(project.root, project.config)) {
    const absolute = path.join(project.root, relative);
    const stat = fs.statSync(absolute);
    const old = previousByPath.get(relative);
    if (
      old && old.size === stat.size && old.mtimeMs === stat.mtimeMs &&
      old.role === (source.role || "reference") && old.authority === Number(source.authority ?? 50)
    ) {
      documents.push(old);
      reusedCount += 1;
      continue;
    }
    const text = fs.readFileSync(absolute, "utf8");
    documents.push(parseDocument(project.root, relative, source, text, stat, project.config.limits.maxBodyTerms));
    readCount += 1;
  }
  const index = {
    indexVersion: INDEX_VERSION,
    root: project.root,
    configHash,
    scannedAt: new Date().toISOString(),
    scannedAtMs: Date.now(),
    stats: { documents: documents.length, readCount, reusedCount },
    documents
  };
  writeJsonAtomic(cachePath, index);
  return { index, cachePath, config: project.config };
}

function ensureIndex(projectRoot, force = false, cacheOnly = false) {
  const project = loadProject(projectRoot);
  const cachePath = cachePathFor(project.root);
  if (!force && fs.existsSync(cachePath)) {
    try {
      const index = readJson(cachePath);
      const configHash = sha256(fs.readFileSync(project.configPath, "utf8"));
      if (
        index.indexVersion === INDEX_VERSION && index.root === project.root && index.configHash === configHash
      ) {
        return { index, cachePath, config: project.config };
      }
    } catch {
      // Rebuild corrupt or incompatible caches below.
    }
  }
  if (cacheOnly) {
    return {
      index: {
        indexVersion: INDEX_VERSION,
        root: project.root,
        configHash: null,
        scannedAt: null,
        scannedAtMs: null,
        stats: { documents: 0, readCount: 0, reusedCount: 0 },
        documents: []
      },
      cachePath,
      config: project.config
    };
  }
  return buildIndex(project.root);
}

function routeMatches(route, prompt) {
  const groups = route.when?.allOfAny;
  if (!Array.isArray(groups) || groups.length === 0) return false;
  const normalized = normalizeText(prompt);
  return groups.every((group) => Array.isArray(group) && group.some((term) => normalized.includes(normalizeText(term))));
}

function resolveHeading(document, requested) {
  if (!requested) {
    const first = document.headings.find((heading) => heading.level === 1);
    return {
      heading: first?.title ?? "",
      line: first?.line ?? 1,
      endLine: Math.min(40, first?.endLine ?? 40)
    };
  }
  const decoded = decodeURIComponent(requested);
  const normalized = slugifyHeading(decoded);
  const heading = document.headings.find((candidate) =>
    candidate.anchor === normalized || normalizeText(candidate.title) === normalizeText(decoded)
  );
  return heading
    ? { heading: heading.title, line: heading.line, endLine: heading.endLine }
    : { heading: decoded, line: 1, endLine: Math.min(40, document.headings[0]?.endLine ?? 40) };
}

function resultFromDocument(document, reason, score, anchor = "", match = null) {
  return {
    path: document.path,
    role: document.role,
    authority: document.authority,
    score,
    reason,
    ...(match ? { match } : {}),
    ...resolveHeading(document, anchor)
  };
}

function semanticTier(document) {
  if (["canonical-doc", "api-contract", "runbook", "adr"].includes(document.role)) return 5;
  if (document.role === "knowledge-entrypoint") return 4;
  if (document.role === "implementation-constraint") return 3;
  if (["task-intent", "task-evidence"].includes(document.role)) return 1;
  return 2;
}

export function queryContext({
  projectRoot,
  prompt,
  forceRefresh = false,
  cacheOnly = false,
  expandExclusive = false
}) {
  const { index, cachePath, config } = ensureIndex(projectRoot, forceRefresh, cacheOnly);
  const byPath = new Map(index.documents.map((document) => [document.path, document]));
  const results = [];
  const seen = new Set();
  const matchedRoutes = config.routes.filter((route) => routeMatches(route, prompt));
  const exclusiveRoute = matchedRoutes.some((route) => route.exclusive === true);

  for (const route of matchedRoutes) {
    for (let indexInRoute = 0; indexInRoute < (route.read ?? []).length; indexInRoute += 1) {
      const reference = route.read[indexInRoute];
      const raw = typeof reference === "string" ? reference : reference.path;
      const hashIndex = raw.indexOf("#");
      const relative = hashIndex < 0 ? raw : raw.slice(0, hashIndex);
      const anchor = hashIndex < 0 ? "" : raw.slice(hashIndex + 1);
      let document = byPath.get(relative);
      if (!document && fs.existsSync(path.join(index.root, relative))) {
        const source = sourceMatcher(config)(relative) || { role: "reference", authority: 50 };
        document = {
          path: relative,
          role: source.role || "reference",
          authority: Number(source.authority ?? 50),
          title: path.basename(relative),
          headings: [],
          links: [],
          keyTerms: [],
          bodyTerms: []
        };
      }
      if (!document || seen.has(relative)) continue;
      seen.add(relative);
      results.push(resultFromDocument(
        document,
        `显式路由 ${route.id}`,
        1000 - indexInRoute,
        anchor,
        { type: "explicit", route: route.id }
      ));
    }
  }

  if (!exclusiveRoute || expandExclusive) {
    const promptTerms = tokenize(prompt);
    const semantic = [];
    for (const document of index.documents) {
      if (seen.has(document.path)) continue;
      const keyTerms = new Set(document.keyTerms);
      const bodyTerms = new Set(document.bodyTerms);
      let keyHits = 0;
      let bodyHits = 0;
      const matched = [];
      for (const term of promptTerms) {
        if (keyTerms.has(term)) {
          keyHits += 1;
          matched.push(term);
        } else if (bodyTerms.has(term)) {
          bodyHits += 1;
          matched.push(term);
        }
      }
      if (keyHits + bodyHits === 0) continue;
      // Authority must be strong enough to keep maintained owners ahead of
      // working-task prose that happens to repeat more generic query terms.
      // Relevance still decides between documents with comparable authority.
      const score = keyHits * 8 + bodyHits * 2 + document.authority / 20;
      semantic.push({
        document,
        score,
        tier: semanticTier(document),
        keyHits,
        bodyHits,
        matched: [...new Set(matched)].slice(0, 5)
      });
    }
    semantic.sort((left, right) =>
      right.tier - left.tier ||
      right.score - left.score ||
      right.document.authority - left.document.authority
    );
    for (const candidate of semantic) {
      if (results.length >= config.limits.maxResults) break;
      seen.add(candidate.document.path);
      results.push(resultFromDocument(
        candidate.document,
        `命中 ${candidate.matched.join("、")}`,
        candidate.score,
        "",
        {
          type: "semantic",
          keyHits: candidate.keyHits,
          bodyHits: candidate.bodyHits
        }
      ));
    }
  }

  let relatedCount = 0;
  if ((!exclusiveRoute || expandExclusive) && results.length < config.limits.maxResults) {
    for (const result of [...results]) {
      const document = byPath.get(result.path);
      for (const link of document?.links ?? []) {
        if (relatedCount >= config.limits.maxRelated || results.length >= config.limits.maxResults) break;
        const related = byPath.get(link.path);
        if (!related || seen.has(related.path)) continue;
        seen.add(related.path);
        relatedCount += 1;
        results.push(resultFromDocument(related, `由 ${document.path} 一跳关联`, result.score - 1, link.anchor));
      }
      if (relatedCount >= config.limits.maxRelated) break;
    }
  }

  return {
    root: index.root,
    cachePath,
    scannedAt: index.scannedAt,
    stats: index.stats,
    matchedRoutes: matchedRoutes.map((route) => route.id),
    trellis: fs.existsSync(path.join(index.root, ".trellis")),
    maxContextChars: config.limits.maxContextChars,
    results
  };
}

function lookupSessionValue(data, keys) {
  if (!data || typeof data !== "object") return null;
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const key of ["input", "properties", "event", "hook_input", "hookInput"]) {
    const value = lookupSessionValue(data[key], keys);
    if (value) return value;
  }
  return null;
}

export function resolveHookSessionKey(payload = {}, env = process.env) {
  const payloadValue = lookupSessionValue(payload, [
    "session_id", "sessionId", "sessionID",
    "conversation_id", "conversationId", "conversationID",
    "thread_id", "threadId", "threadID",
    "transcript_path", "transcriptPath", "transcript"
  ]);
  const environmentValue = env.CODEX_SESSION_ID || env.CODEX_THREAD_ID || env.CODEX_TRANSCRIPT_PATH;
  const value = payloadValue || environmentValue;
  return value ? sha256(String(value)).slice(0, 24) : null;
}

function sessionRoutePath(projectRoot, sessionKey) {
  return path.join(path.dirname(cachePathFor(projectRoot)), "sessions", `${sessionKey}.json`);
}

function routeSignature(context) {
  return sha256(JSON.stringify({
    matchedRoutes: context.matchedRoutes,
    results: context.results.map((result) => ({
      path: result.path,
      heading: result.heading,
      line: result.line,
      endLine: result.endLine
    }))
  }));
}

function sanitizeRouteResult(result) {
  return {
    path: result.path,
    role: result.role ?? "reference",
    authority: Number(result.authority ?? 50),
    score: Number(result.score ?? 0),
    reason: result.reason ?? "会话活动路由",
    heading: result.heading ?? "",
    line: Number(result.line ?? 1),
    endLine: Number(result.endLine ?? 40),
    ...(result.match ? { match: result.match } : {})
  };
}

function routeNodeKey(result) {
  return `${result.path}#${result.heading || `${result.line}-${result.endLine}`}`;
}

function newSessionGraph(projectRoot) {
  return {
    version: 2,
    root: path.resolve(projectRoot),
    activeBranchId: null,
    updatedAt: new Date().toISOString(),
    branches: []
  };
}

function migrateSessionGraph(projectRoot, state) {
  if (state?.version === 2 && Array.isArray(state.branches)) return state;
  if (state?.route && Array.isArray(state.route.results)) {
    const branchId = `branch-${String(state.signature || sha256(JSON.stringify(state.route))).slice(0, 12)}`;
    return {
      version: 2,
      root: path.resolve(projectRoot),
      activeBranchId: branchId,
      updatedAt: state.updatedAt || new Date().toISOString(),
      branches: [{
        id: branchId,
        createdAt: state.updatedAt || new Date().toISOString(),
        updatedAt: state.updatedAt || new Date().toISOString(),
        matchedRoutes: Array.isArray(state.route.matchedRoutes) ? state.route.matchedRoutes : [],
        nodes: state.route.results.map(sanitizeRouteResult)
      }]
    };
  }
  return newSessionGraph(projectRoot);
}

function readSessionGraph(projectRoot, sessionKey) {
  if (!sessionKey) return null;
  const file = sessionRoutePath(projectRoot, sessionKey);
  if (!fs.existsSync(file)) return null;
  try {
    const state = readJson(file);
    if (state?.root !== path.resolve(projectRoot)) return null;
    return migrateSessionGraph(projectRoot, state);
  } catch {
    return null;
  }
}

function writeSessionGraph(projectRoot, sessionKey, graph) {
  if (!sessionKey) return;
  writeJsonAtomic(sessionRoutePath(projectRoot, sessionKey), graph);
}

function confidentInitialRoute(context) {
  if (context.matchedRoutes.length > 0) return true;
  const top = context.results[0]?.match;
  const keyHits = Number(top?.keyHits ?? 0);
  const bodyHits = Number(top?.bodyHits ?? 0);
  return keyHits >= 2 || (keyHits >= 1 && bodyHits >= 1);
}

function graphSummary(graph) {
  return {
    activeBranchId: graph?.activeBranchId ?? null,
    branchCount: graph?.branches?.length ?? 0,
    branches: (graph?.branches ?? []).map((branch) => ({
      id: branch.id,
      active: branch.id === graph.activeBranchId,
      matchedRoutes: branch.matchedRoutes,
      nodeCount: branch.nodes.length
    }))
  };
}

function contextWithState(context, routeState, results = context.results) {
  return {
    ...context,
    results,
    routeState
  };
}

function contextFromBranch(projectRoot, branch, graph, mode, results = branch.nodes) {
  const project = loadProject(projectRoot);
  return {
    root: project.root,
    cachePath: cachePathFor(project.root),
    scannedAt: null,
    stats: null,
    matchedRoutes: branch.matchedRoutes,
    trellis: fs.existsSync(path.join(project.root, ".trellis")),
    maxContextChars: project.config.limits.maxContextChars,
    results: results.slice(0, project.config.limits.maxResults),
    routeState: {
      mode,
      branchId: branch.id,
      branchCount: graph.branches.length,
      nodeCount: branch.nodes.length
    }
  };
}

function createBranch(context, now) {
  const signature = routeSignature(context);
  return {
    id: `branch-${signature.slice(0, 12)}`,
    createdAt: now,
    updatedAt: now,
    matchedRoutes: [...new Set(context.matchedRoutes)],
    nodes: context.results.map(sanitizeRouteResult)
  };
}

export function updateSessionRoute({
  projectRoot,
  prompt,
  payload = {},
  env = process.env,
  forceRefresh = false,
  expandExclusive = false
}) {
  const sessionKey = resolveHookSessionKey(payload, env);
  const existingGraph = readSessionGraph(projectRoot, sessionKey);
  let context = queryContext({
    projectRoot,
    prompt,
    forceRefresh,
    cacheOnly: !forceRefresh
  });
  if (expandExclusive && context.matchedRoutes.length > 0) {
    const reactivatesExisting = existingGraph?.branches.some((branch) =>
      branch.id !== existingGraph.activeBranchId &&
      branch.matchedRoutes.some((routeId) => context.matchedRoutes.includes(routeId))
    );
    if (!reactivatesExisting) {
      context = queryContext({
        projectRoot,
        prompt,
        forceRefresh,
        cacheOnly: !forceRefresh,
        expandExclusive: true
      });
    }
  }

  if (!confidentInitialRoute(context)) {
    return {
      status: "no-match",
      context: null,
      graph: graphSummary(existingGraph)
    };
  }
  if (!sessionKey) {
    return {
      status: "unscoped",
      context: contextWithState(context, { mode: "unscoped", branchId: null, branchCount: 0 }),
      graph: graphSummary(null)
    };
  }

  const graph = existingGraph ?? newSessionGraph(projectRoot);
  const now = new Date().toISOString();
  const candidateNodes = context.results.map(sanitizeRouteResult);
  const activeBefore = graph.activeBranchId;

  let branch = null;
  if (context.matchedRoutes.length > 0) {
    branch = graph.branches.find((existing) =>
      existing.matchedRoutes.some((routeId) => context.matchedRoutes.includes(routeId))
    ) ?? null;
  } else {
    const primaryPath = candidateNodes[0]?.path ?? null;
    const matching = primaryPath
      ? graph.branches.filter((existing) =>
        existing.nodes.some((node) => node.path === primaryPath)
      )
      : [];
    branch = matching.find((existing) => existing.id === graph.activeBranchId) ?? matching[0] ?? null;
  }

  let status;
  let outputResults;
  if (!branch) {
    branch = createBranch(context, now);
    const collision = graph.branches.find((existing) => existing.id === branch.id);
    if (collision) branch.id = `${branch.id}-${graph.branches.length + 1}`;
    graph.branches.push(branch);
    status = graph.branches.length === 1 ? "created" : "branched";
    outputResults = branch.nodes;
  } else {
    const existingKeys = new Set(branch.nodes.map(routeNodeKey));
    const added = candidateNodes.filter((node) => !existingKeys.has(routeNodeKey(node)));
    const merged = [];
    const seen = new Set();
    for (const node of [...candidateNodes, ...branch.nodes]) {
      const key = routeNodeKey(node);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(node);
    }
    branch.nodes = merged;
    branch.matchedRoutes = [...new Set([...context.matchedRoutes, ...branch.matchedRoutes])];
    branch.updatedAt = now;
    if (branch.id !== activeBefore) {
      status = added.length > 0 ? "reactivated-expanded" : "reactivated";
      outputResults = branch.nodes;
    } else if (added.length > 0) {
      status = "expanded";
      outputResults = added;
    } else {
      status = "unchanged";
      outputResults = [];
    }
  }

  graph.activeBranchId = branch.id;
  graph.updatedAt = now;
  writeSessionGraph(projectRoot, sessionKey, graph);

  return {
    status,
    context: contextFromBranch(projectRoot, branch, graph, status, outputResults),
    graph: graphSummary(graph)
  };
}

export function currentSessionFocus({ projectRoot, payload = {}, env = process.env }) {
  const sessionKey = resolveHookSessionKey(payload, env);
  const graph = readSessionGraph(projectRoot, sessionKey);
  if (!graph) return null;
  const branch = graph.branches.find((candidate) => candidate.id === graph.activeBranchId);
  if (!branch) return null;
  return contextFromBranch(projectRoot, branch, graph, "focus");
}

export function queryHookContext({ projectRoot, prompt, payload = {}, env = process.env }) {
  const focus = currentSessionFocus({ projectRoot, payload, env });
  if (focus) return focus;
  return updateSessionRoute({ projectRoot, prompt, payload, env }).context;
}

export function formatContext(context, { hook = false } = {}) {
  const mode = context.routeState?.mode ?? "route";
  if (mode === "unchanged") {
    return `[Atlas route] unchanged; branch=${context.routeState.branchId}; ` +
      "当前知识节点已覆盖完整任务意图，无需重复读取。";
  }
  if (context.results.length === 0) return "";
  const stateSuffix = context.routeState?.branchId
    ? `; branch=${context.routeState.branchId}; branches=${context.routeState.branchCount}`
    : "";
  const header = mode === "focus"
    ? `[Atlas focus] project=${context.root}; branch=${context.routeState.branchId}; branches=${context.routeState.branchCount}`
    : `[Atlas route${mode === "route" || mode === "created" || mode === "unscoped" ? "" : `:${mode}`}] project=${context.root}${stateSuffix}`;
  const instruction = mode === "focus"
    ? `${hook ? "Atlas hook 已恢复" : "已恢复"}当前活动分支；继续使用以下知识节点，不要因当前一句话重新检索、重复读取或再次加载 Atlas skill。准备执行超出这些节点的新非平凡操作前，才使用完整会话意图运行 atlas-router route。`
    : mode === "expanded"
      ? "当前分支已扩展；只读取以下新增节点，旧节点保持有效。不要为同一意图再次运行 context/route/focus，也不要探测插件缓存或 Atlas skill 的版本路径。"
      : `${hook ? "Atlas hook 已在模型开始工作前完成路由。" : "Atlas 路由已完成。"}第一项仓库内容操作必须是按顺序读取以下路径/章节；不要先运行 git status、find、全项目 rg 或源码扫描。不要为同一意图再次运行 context/route/focus，也不要探测插件缓存或 Atlas skill 的版本路径。资料足以执行时直接执行且不要遍历源码；只有冲突、缺失或失败再做一次聚焦扩展；易漂移事实仍以当前配置或运行态复核：`;
  const lines = [
    header,
    instruction
  ];
  context.results.forEach((result, index) => {
    const section = result.heading ? `#${result.heading}` : "";
    lines.push(
      `${index + 1}. ${path.join(context.root, result.path)}${section} ` +
      `(lines ${result.line}-${result.endLine}; ${result.role}; ${result.reason})`
    );
  });
  if (context.trellis) {
    lines.push("Trellis 适配：.trellis 仅提供任务意图、实施约束和历史证据，不覆盖 docs/代码/配置中的当前真源。");
  }
  const output = lines.join("\n");
  return output.slice(0, context.maxContextChars || DEFAULT_LIMITS.maxContextChars);
}

export function initProject(target, { trellis = false } = {}) {
  const root = path.resolve(target);
  fs.mkdirSync(path.join(root, ".atlas"), { recursive: true });
  const configPath = path.join(root, CONFIG_RELATIVE_PATH);
  if (fs.existsSync(configPath)) throw new Error(`Atlas 配置已存在：${configPath}`);
  const config = structuredClone(DEFAULT_CONFIG);
  if (!trellis) {
    config.sources = config.sources.filter((source) => !source.glob.startsWith(".trellis/"));
  }
  writeJsonAtomic(configPath, config);
  fs.writeFileSync(path.join(root, ".atlas", ".gitignore"), "runtime/\n*.tmp\n", "utf8");
  return configPath;
}

export function diagnose(projectRoot) {
  const project = loadProject(projectRoot);
  const cachePath = cachePathFor(project.root);
  const cache = fs.existsSync(cachePath) ? readJson(cachePath) : null;
  const projectHook = path.join(project.root, ".codex", "hooks.json");
  const trellis = fs.existsSync(path.join(project.root, ".trellis"));
  return {
    root: project.root,
    configPath: project.configPath,
    configValid: true,
    sources: project.config.sources.length,
    routes: project.config.routes.length,
    cachePath,
    cachePresent: Boolean(cache),
    indexedDocuments: cache?.documents?.length ?? 0,
    lastScan: cache?.scannedAt ?? null,
    trellis,
    trellisSpecSources: project.config.sources.filter((source) => source.glob.startsWith(".trellis/spec/")).length,
    archiveExcluded: project.config.exclude.some((glob) => glob.startsWith(".trellis/tasks/archive")),
    projectHook: fs.existsSync(projectHook) ? projectHook : null,
    hookContract: "Atlas 与其他 UserPromptSubmit hooks 独立运行，不依赖执行顺序。"
  };
}

export function defaultConfig() {
  return structuredClone(DEFAULT_CONFIG);
}
