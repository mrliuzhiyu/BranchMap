#!/usr/bin/env node
/**
 * 文档治理闸。抄自 siltok_web 的 scripts/check-docs.mjs（2026-10-07），去掉了五仓共同约定段的校验。
 *
 * 规则真源是 docs/DOC_GOVERNANCE.md，本文件只实现它。改判据先改那份文档。
 *
 * ERROR（退出码 1）：
 *   指令文件  AGENTS.md 缺失；CLAUDE.md 存在但内容不是一行 `@AGENTS.md`
 *   docs/   缺必需文档；缺 frontmatter；status / type 非法；superseded 缺 superseded_by 或指向不存在；
 *            未在 docs/README.md 登记（孤儿）；索引失链；索引漂移；重复登记
 *   issues/  未在 issues/README.md 登记（孤儿）；索引失链；表错位（文件在 done/ 却登记在「进行中」表，
 *            或反之）；索引状态符号与文件 `> 状态：` 头不一致；
 *            open/ 里的 issue 标着 ✅/🗄️（做完了却没归档），或 done/ 里的不是 ✅/🗄️；
 *            文件名不是 YYYYMMDD-slug.md
 *   链接     仓库内 Markdown 的本地相对链接失效（docs/archive/ 与 issues/done/ 是冻结的历史，不查）
 *
 * WARN（不阻断）：verified 超期 / 缺失 / 不可解析
 *
 * 本地跑：node scripts/check-docs.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const DOCS = join(ROOT, "docs");
const ARCHIVE = "docs/archive/";
const ISSUES = join(ROOT, "issues");

const VALID_STATUS = new Set(["authoritative", "active", "draft", "historical", "superseded"]);
const VALID_TYPE = new Set(["spec", "guide", "progress", "research", "roadmap", "reference"]);
const STALE_DAYS = { spec: 365, reference: 180, guide: 180, roadmap: 120, research: 90, progress: 60 };
const FRESHNESS_EXEMPT = new Set(["authoritative", "historical", "superseded"]);
// ✅ 已验收 与 🗄️ 被取代归档 都在 done/，但含义相反，别合并
const STATUS_MARKS = ["✅", "🔧", "📋", "🔍", "⏸", "❌", "🗄️"];
const AGENT_FILES = new Set(["AGENTS.md", "CLAUDE.md"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const REQUIRED = ["AGENTS.md", "README.md", "TODOS.md", "docs/README.md", "docs/DOC_GOVERNANCE.md"];
// 冻结的历史不查链接
const LINK_SKIP = [ARCHIVE, "issues/done/"];

const errors = [];
const warnings = [];
const rel = (p) => relative(ROOT, p).split("\\").join("/");
const read = (p) => readFileSync(p, "utf8").replace(/^\uFEFF/, "");

function walkMd(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkMd(full));
    else if (name.endsWith(".md")) out.push(full);
  }
  return out;
}

/** 仓库内受版本控制（含未跟踪但未忽略）的 Markdown。gitignore 掉的本地产物不归闸管。 */
function repoMarkdown() {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.md"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return [...new Set(out.split("\0").filter(Boolean))].filter((p) => existsSync(join(ROOT, p)));
  } catch {
    return walkMd(ROOT).map(rel);
  }
}

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  const fields = {};
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes(":")) continue;
    const i = line.indexOf(":");
    fields[line.slice(0, i).trim()] = line
      .slice(i + 1)
      .replace(/\s+#.*$/, "")
      .trim()
      .replace(/^['"]|['"]$/g, "");
  }
  return fields;
}

/** 去掉围栏代码块与行内代码，避免把示例里的 `[x](y)` 当成链接。 */
function stripCode(text) {
  return text.replace(/^(```|~~~)[\s\S]*?^\1/gm, "").replace(/`[^`\n]*`/g, "");
}

function linksIn(line) {
  const out = [];
  for (const m of line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push(m[1]);
  return out;
}

/** 本地相对链接 → 去掉锚点与查询串后的路径；外链、纯锚点、绝对路径返回 null。 */
function localTarget(raw) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#") || raw.startsWith("/")) return null;
  const path = raw.split("#")[0].split("?")[0];
  if (!path) return null;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

const cells = (line) => line.split("|").map((c) => c.replace(/[*`]/g, "").trim());

// ── 指令文件 ────────────────────────────────────────────────────────────
for (const p of REQUIRED) {
  if (!existsSync(join(ROOT, p))) errors.push(`缺少必需文档：${p}`);
}
if (existsSync(join(ROOT, "CLAUDE.md")) && read(join(ROOT, "CLAUDE.md")).trim() !== "@AGENTS.md") {
  errors.push("CLAUDE.md 只能是一行 `@AGENTS.md`：指令真源是 AGENTS.md，两份并行维护必漂");
}

// ── docs/ 状态头与新鲜度 ────────────────────────────────────────────────
const today = new Date(new Date().toISOString().slice(0, 10));
const headers = new Map();
const docFiles = walkMd(DOCS)
  .map(rel)
  .filter((p) => !p.startsWith(ARCHIVE) && !AGENT_FILES.has(p.split("/").pop()));

for (const key of docFiles) {
  const fm = parseFrontmatter(read(join(ROOT, key)));
  if (!fm) {
    errors.push(`${key}：缺 frontmatter 状态头（见 docs/DOC_GOVERNANCE.md）`);
    continue;
  }
  const { status = "", type = "", verified = "" } = fm;
  if (!VALID_STATUS.has(status)) errors.push(`${key}：status 非法或缺失（${status || "空"}）`);
  if (!VALID_TYPE.has(type)) errors.push(`${key}：type 非法或缺失（${type || "空"}）`);
  if (status === "superseded") {
    if (!fm.superseded_by) errors.push(`${key}：status=superseded 必须填 superseded_by`);
    else if (!existsSync(resolve(ROOT, dirname(key), fm.superseded_by)))
      errors.push(`${key}：superseded_by 指向不存在的文件（${fm.superseded_by}）`);
  }
  headers.set(key, { status, type, verified });

  if (FRESHNESS_EXEMPT.has(status)) continue;
  if (!DATE_RE.test(verified)) {
    warnings.push(`${key}：verified 缺失或不是 YYYY-MM-DD（${verified || "空"}）`);
    continue;
  }
  const age = Math.floor((today - new Date(verified)) / 86_400_000);
  const limit = STALE_DAYS[type];
  if (limit && age > limit) warnings.push(`${key}：verified ${verified} 已 ${age} 天（${type} 阈值 ${limit} 天）→ 待复核`);
}

// ── docs/README.md 索引：孤儿 / 失链 / 漂移 / 重复登记 ───────────────────
const indexPath = join(DOCS, "README.md");
if (existsSync(indexPath)) {
  const seen = new Map(); // key -> 带元数据的登记行数
  const mentioned = new Set();
  for (const line of stripCode(read(indexPath)).split(/\r?\n/)) {
    for (const raw of linksIn(line)) {
      const target = localTarget(raw);
      if (!target || !target.endsWith(".md")) continue;
      const key = rel(resolve(DOCS, target));
      if (!key.startsWith("docs/")) continue;
      if (!existsSync(join(ROOT, key))) {
        errors.push(`docs/README.md 索引失链：${raw}`);
        continue;
      }
      mentioned.add(key);
      const header = headers.get(key);
      if (!header || !line.trimStart().startsWith("|")) continue;
      const c = cells(line);
      const got = {
        status: c.find((x) => VALID_STATUS.has(x)),
        type: c.find((x) => VALID_TYPE.has(x)),
        verified: c.find((x) => DATE_RE.test(x)),
      };
      if (!got.status && !got.type && !got.verified) continue;
      if (got.status) seen.set(key, (seen.get(key) ?? 0) + 1);
      for (const field of ["status", "type", "verified"]) {
        if (got[field] && got[field] !== header[field])
          errors.push(`索引漂移：docs/README.md 写 ${key} 的 ${field}=${got[field]}，文档自身是 ${header[field] || "空"}`);
      }
    }
  }
  for (const [key, n] of seen) if (n > 1) errors.push(`重复登记：${key} 在 docs/README.md 有 ${n} 条元数据行`);
  for (const key of headers.keys()) {
    if (key !== "docs/README.md" && !mentioned.has(key)) errors.push(`孤儿文档：${key} 未在 docs/README.md 登记`);
  }
}

// ── issues/ 索引：孤儿 / 失链 / 表错位 / 状态漂移 ────────────────────────
if (existsSync(ISSUES)) {
  const readme = join(ISSUES, "README.md");
  if (!existsSync(readme)) {
    errors.push("issues/README.md 缺失：issue 索引是流程的一部分");
  } else {
    const existing = new Set(
      ["open", "done"].flatMap((sub) =>
        existsSync(join(ISSUES, sub))
          ? readdirSync(join(ISSUES, sub))
              .filter((n) => n.endsWith(".md"))
              .map((n) => `${sub}/${n}`)
          : [],
      ),
    );
    const listed = new Map();
    let section = null;
    for (const line of read(readme).split(/\r?\n/)) {
      if (line.startsWith("## ")) {
        const title = line.slice(3);
        section = title.includes("进行中") ? "open" : title.includes("已归档") ? "done" : null;
      }
      for (const raw of linksIn(line)) {
        const target = raw.split("#")[0];
        if (!/^(open|done)\//.test(target)) continue;
        if (!listed.has(target)) listed.set(target, new Set());
        if (section) listed.get(target).add(section);
        if (!existing.has(target)) {
          errors.push(`issues/README.md 索引失链：${target}`);
          continue;
        }
        const row = /^\|\s*\[[^\]]+\]\([^)]+\)\s*\|.*?\|([^|]*)\|[^|]*\|\s*$/.exec(line);
        if (!row) continue;
        const head = read(join(ISSUES, target))
          .split(/\r?\n/)
          .find((l) => l.startsWith("> 状态："));
        const want = STATUS_MARKS.find((s) => head?.includes(s));
        const got = STATUS_MARKS.find((s) => row[1].includes(s));
        if (!want) errors.push(`issues/${target}：缺 \`> 状态：\` 头或状态里没有状态符号（${STATUS_MARKS.join(" ")}）`);
        else if (got !== want) errors.push(`issues/${target}：索引状态是「${got ?? "无符号"}」，文件状态头是「${want}」`);
      }
    }
    for (const target of existing) {
      if (!listed.has(target)) errors.push(`孤儿 issue：issues/${target} 未在 issues/README.md 登记`);
    }
    // 文件名必须是 YYYYMMDD-slug.md：日期不带连字符、slug 只用小写字母数字与连字符，
    // 否则按名字排序就不再是按日期排序，跨仓也对不齐
    for (const target of existing) {
      const name = target.split("/")[1];
      if (!/^\d{8}-[a-z0-9]+(-[a-z0-9]+)*\.md$/.test(name))
        errors.push(`issues/${target} 文件名不合规：应为 YYYYMMDD-slug.md（小写字母、数字、连字符）`);
    }
    // 目录与状态必须一致：做完的留在 open/ 会让「还剩什么没做」失真
    for (const target of existing) {
      const head = read(join(ISSUES, target)).split(/\r?\n/).find((l) => l.startsWith("> 状态："));
      const mark = STATUS_MARKS.find((s) => head?.includes(s));
      const closed = mark === "✅" || mark === "🗄️";
      if (target.startsWith("open/") && closed)
        errors.push(`issues/${target} 状态是 ${mark} 却还在 open/：剩余非代码活摘进 TODOS.md，再 git mv 到 done/ 并挪索引行`);
      if (target.startsWith("done/") && mark && !closed)
        errors.push(`issues/${target} 在 done/ 但状态是 ${mark}：没做完就移回 open/，做完就改状态头`);
    }
    for (const [target, sections] of listed) {
      if (!existing.has(target)) continue;
      const actual = target.split("/")[0];
      if ([...sections].some((s) => s !== actual))
        errors.push(`索引表错位：issues/${target} 在 ${actual}/，却登记在另一张表里（归档要一起改状态头、git mv、挪索引行）`);
    }
  }
}

// ── 全仓 Markdown 本地链接 ──────────────────────────────────────────────
const markdown = repoMarkdown();
for (const key of markdown) {
  if (LINK_SKIP.some((prefix) => key.startsWith(prefix))) continue;
  const text = stripCode(read(join(ROOT, key)));
  for (const line of text.split(/\r?\n/)) {
    for (const raw of linksIn(line)) {
      const target = localTarget(raw);
      if (target && !existsSync(resolve(ROOT, dirname(key), target))) errors.push(`${key} 链接失效：${raw}`);
    }
  }
}

// ── 报告 ────────────────────────────────────────────────────────────────
if (warnings.length) {
  console.log("⚠️  待复核（不阻断，每月清一次）：");
  for (const w of warnings) console.log(`   - ${w}`);
  console.log();
}
if (errors.length) {
  console.log("❌ 文档治理检查失败：");
  for (const e of errors) console.log(`   - ${e}`);
  console.log(`\n共 ${errors.length} 个错误。规则见 docs/DOC_GOVERNANCE.md。`);
  process.exit(1);
}
console.log(`✅ 文档治理检查通过（docs ${docFiles.length} 份 · 全仓 Markdown ${markdown.length} 份 · ${warnings.length} 条待复核）。`);
