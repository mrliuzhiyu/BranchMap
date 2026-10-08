// 一个仓库的查询：提交图、提交详情、对比、差异、文件内容、PR。全部只读。
// 跑在 BranchMap 自己的云端副本上；本机的工作树由调用方（本机扫描）提供，只用来在提交图上标出位置。
import { git, firstLine, checkRev, checkPath, EMPTY_TREE } from './git.mjs';
import { groupPeople, lookupAccounts } from './people.mjs';
import { githubSlug } from './remote.mjs';

const US = '\x1f';
const RS = '\x1e';
const MAX_COMMITS = 50000;
const MAX_PATCH = 4 * 1024 * 1024;
const MAX_BLOB = 8 * 1024 * 1024;
const PROD_NAMES = ['main', 'master', 'trunk', 'production', 'prod'];
const DEV_NAMES = ['dev', 'develop', 'development', 'staging'];

/** diff-tree 的 -z --numstat 与 -z --name-status，合成文件列表。 */
function parseChanges(numstat, nameStatus) {
  const files = [];
  const byPath = new Map();
  const t = nameStatus.split('\0');
  for (let i = 0; i < t.length - 1; ) {
    const code = t[i];
    if (!code) {
      i++;
      continue;
    }
    if (code[0] === 'R' || code[0] === 'C') {
      const f = { st: code[0], old: t[i + 1], p: t[i + 2], sim: Number(code.slice(1)) || null, add: 0, del: 0, bin: false };
      files.push(f);
      byPath.set(f.p, f);
      i += 3;
    } else {
      const f = { st: code[0], p: t[i + 1], add: 0, del: 0, bin: false };
      files.push(f);
      byPath.set(f.p, f);
      i += 2;
    }
  }
  const n = numstat.split('\0');
  for (let i = 0; i < n.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(n[i]);
    if (!m) continue;
    let path = m[3];
    if (!path) {
      path = n[i + 2];
      i += 2;
    }
    const f = byPath.get(path);
    if (!f) continue;
    if (m[1] === '-') f.bin = true;
    else {
      f.add = Number(m[1]);
      f.del = Number(m[2]);
    }
  }
  return files;
}

export class Repo {
  /**
   * name：显示名；dir：git 目录（云端副本）；ctx：{ accounts, aliases }；
   * opts.url：远程地址；opts.worktrees()：本机工作树 [{ path, head, branch, detached, temp }]
   */
  constructor(name, dir, ctx, opts = {}) {
    this.name = name;
    this.dir = dir;
    this.ctx = ctx;
    this.url = opts.url ?? null;
    this.worktreesOf = opts.worktrees ?? (() => []);
    this.graphCache = null;
    this.prCache = null;
    this.prPromise = null;
    this.building = null;
  }

  get slug() {
    return githubSlug(this.url);
  }

  /* ------------------------------------------------------------------ 提交图 */

  async graph() {
    const fmt = ['%(refname)', '%(objectname)', '%(*objectname)', '%(objecttype)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(creatordate:unix)', '%(symref)', '%(contents:subject)'].join('%1f') + '%1e';
    const [refsRaw, originHead] = await Promise.all([
      git(this.dir, ['for-each-ref', '--format=' + fmt, 'refs/heads', 'refs/remotes', 'refs/tags']),
      git(this.dir, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']).catch(() => ''),
    ]);
    const worktrees = this.worktreesOf();
    const key = refsRaw + '|' + originHead + '|' + worktrees.map((w) => w.path + ':' + w.head + ':' + w.branch).join('|');
    if (this.graphCache?.key === key) return this.graphCache.value;
    if (this.building?.key === key) return this.building.promise;
    const promise = this.buildGraph(refsRaw, worktrees, originHead.trim()).then((value) => {
      this.graphCache = { key, value };
      this.building = null;
      return value;
    }, (e) => {
      this.building = null;
      throw e;
    });
    this.building = { key, promise };
    return promise;
  }

  async buildGraph(refsRaw, worktrees, originHead) {
    const refs = [];
    for (const rec of refsRaw.split(RS)) {
      const line = rec.replace(/^\n/, '');
      if (!line) continue;
      const [ref, sha, peeled, type, upstream, track, date, symref, subject] = line.split(US);
      if (symref) continue; // origin/HEAD
      if (ref.startsWith('refs/heads/')) refs.push({ n: ref.slice(11), k: 'L', sha, up: upstream || null, tr: track || null });
      else if (ref.startsWith('refs/remotes/')) {
        const rest = ref.slice(13);
        const i = rest.indexOf('/');
        refs.push({ n: rest, k: 'R', sha, remote: rest.slice(0, i), short: rest.slice(i + 1) });
      } else if (ref.startsWith('refs/tags/')) {
        refs.push({ n: ref.slice(10), k: 'T', sha: type === 'tag' ? peeled : sha, d: Number(date) || null, m: type === 'tag' ? subject : null, ann: type === 'tag' });
      }
    }

    const logArgs = ['log', '--date-order', `--max-count=${MAX_COMMITS}`, '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%s', '--branches', '--remotes', '--tags', '--'];
    const log = await git(this.dir, logArgs);
    const lines = log.split('\n').filter(Boolean);
    const index = new Map();
    lines.forEach((l, i) => index.set(l.slice(0, 40), i));
    const commits = { h: [], p: [], a: [], t: [], ct: [], s: [] };
    const pairs = new Map();
    const pairOf = [];
    const samples = new Map(); // email -> 一个提交号（去 GitHub 问账号用）
    for (const l of lines) {
      const [sha, parents, an, ae, at, ct, s] = l.split(US);
      const pk = an + '\0' + ae;
      pairs.set(pk, (pairs.get(pk) ?? 0) + 1);
      pairOf.push(pk);
      if (ae && !samples.has(ae.toLowerCase())) samples.set(ae.toLowerCase(), sha);
      commits.h.push(sha);
      commits.p.push(parents ? parents.split(' ').map((q) => index.get(q)).filter((q) => q !== undefined) : []);
      commits.t.push(Number(at));
      commits.ct.push(Number(ct));
      commits.s.push(s.length > 300 ? s.slice(0, 299) + '…' : s);
    }

    await lookupAccounts(this.ctx.accounts, this.ctx.github, this.slug, samples).catch(() => {});
    const { people, byPair } = groupPeople(pairs, this.ctx.accounts, this.ctx.aliases);
    commits.a = pairOf.map((pk) => byPair.get(pk));
    this.byPair = byPair;

    const outRefs = refs.map((r) => ({ ...r, c: index.get(r.sha) ?? -1, sha: undefined })).filter((r) => r.c >= 0);
    const names = new Set(outRefs.filter((r) => r.k === 'L').map((r) => r.n));
    for (const r of outRefs) if (r.k === 'R' && r.remote === 'origin') names.add(r.short);
    const oh = originHead.replace(/^origin\//, '');
    const prod = oh && !DEV_NAMES.includes(oh) && names.has(oh) ? oh : PROD_NAMES.find((n) => names.has(n)) ?? null;
    const dev = DEV_NAMES.find((n) => names.has(n) && n !== prod) ?? null;

    return {
      name: this.name,
      slug: this.slug,
      url: this.url,
      generatedAt: Math.floor(Date.now() / 1000),
      trunk: { prod, dev },
      head: null,
      commits,
      truncated: lines.length >= MAX_COMMITS,
      refs: outRefs,
      worktrees: worktrees.map((w, i) => ({ id: w.id ?? i, path: w.path, branch: w.branch, c: w.head ? index.get(w.head) ?? -1 : -1, main: false, temp: !!w.temp, detached: !!w.detached, prunable: false })),
      people,
    };
  }

  personId(name, email) {
    return this.byPair?.get(name + '\0' + email) ?? -1;
  }
  async ensureGraph() {
    if (!this.byPair) await this.graph();
  }

  /* ------------------------------------------------------------------ 提交 / 差异 */

  async commit(sha, parent = 1) {
    checkRev(sha);
    const meta = await git(this.dir, ['show', '-s', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B', '--end-of-options', sha]);
    const [h, parents, an, ae, at, cn, ce, ct, ...body] = meta.split(US);
    const ps = parents ? parents.split(' ') : [];
    const base = ps[parent - 1] ?? EMPTY_TREE;
    await this.ensureGraph();
    return {
      h,
      parents: ps,
      author: { name: an, email: ae, time: Number(at), id: this.personId(an, ae) },
      committer: { name: cn, email: ce, time: Number(ct) },
      message: body.join(US).replace(/\s+$/, ''),
      base: ps.length ? base : null,
      parent,
      files: await this.changes(base, h),
    };
  }

  async changes(from, to) {
    const args = ['-r', '-z', '-M', '--no-commit-id', from, to];
    const [ns, st] = await Promise.all([
      git(this.dir, ['diff-tree', '--numstat', ...args]),
      git(this.dir, ['diff-tree', '--name-status', ...args]),
    ]);
    return parseChanges(ns, st);
  }

  /** 两个引用的对比：合并基点、各自独有的提交数、base...head 的文件变化。 */
  async compare(base, head) {
    checkRev(base);
    checkRev(head);
    const [mb, counts] = await Promise.all([
      git(this.dir, ['merge-base', '--end-of-options', base, head]).then((s) => s.trim()).catch(() => null),
      git(this.dir, ['rev-list', '--left-right', '--count', `${base}...${head}`, '--']).then((s) => s.trim().split(/\s+/).map(Number)).catch(() => [0, 0]),
    ]);
    const headSha = (await git(this.dir, ['rev-parse', '--verify', '--end-of-options', head + '^{commit}'])).trim();
    const files = mb ? await this.changes(mb, headSha) : await this.changes(EMPTY_TREE, headSha);
    return { base, head, mergeBase: mb, behind: counts[0], ahead: counts[1], headSha, files };
  }

  async diff({ from, to, path, old, ctx = 3, ws = false }) {
    checkRev(to);
    if (from && from !== 'EMPTY') checkRev(from);
    checkPath(path);
    if (old) checkPath(old);
    const paths = old && old !== path ? [old, path] : [path];
    const args = ['diff', '--no-color', '--no-ext-diff', '-M', `-U${Math.min(Number(ctx) || 3, 100000)}`];
    if (ws) args.push('-w');
    args.push(!from || from === 'EMPTY' ? EMPTY_TREE : from, to, '--', ...paths);
    const patch = await git(this.dir, args);
    if (patch.length > MAX_PATCH) return { tooLarge: true, size: patch.length };
    const binary = /^Binary files .* differ$/m.test(patch) && !/^@@/m.test(patch);
    return { patch: binary ? '' : patch, binary };
  }

  /** 文件内容（差异里看图片用）。 */
  async blob(ref, path) {
    checkRev(ref);
    checkPath(path);
    const spec = `${ref}:${path}`;
    const size = Number((await git(this.dir, ['cat-file', '-s', spec])).trim());
    if (size > MAX_BLOB) return { size, tooLarge: true };
    const buf = await git(this.dir, ['cat-file', 'blob', spec], { buffer: true });
    return { size, buf, binary: buf.subarray(0, 8000).includes(0) };
  }

  /* ------------------------------------------------------------------ PR */

  /** PR 列表（5 分钟缓存；Webhook 来了会强制刷新）。读不到（没连 GitHub、不是 GitHub 仓库）时返回 available: false。 */
  async prs(refresh = false) {
    if (!refresh && this.prCache && Date.now() - this.prCache.at < 5 * 60 * 1000) return this.prCache.value;
    if (this.prPromise) return this.prPromise;
    this.prPromise = this.loadPrs().finally(() => {
      this.prPromise = null;
    });
    return this.prPromise;
  }

  async loadPrs() {
    const slug = this.slug;
    const gh = this.ctx.github;
    let value;
    if (!slug) value = { available: false, reason: '不是 GitHub 仓库', list: [] };
    else {
      try {
        const token = await gh.tokenFor(slug);
        if (!token) throw Object.assign(new Error(gh.missingReason()), { quiet: true });
        // 最近更新的 500 个（新的在前）
        const raw = [];
        for (let page = 1; page <= 5; page++) {
          const batch = await gh.request(`/repos/${slug}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`, { token });
          raw.push(...batch);
          if (batch.length < 100) break;
        }
        value = {
          available: true,
          list: raw.map((p) => ({
            n: p.number,
            title: p.title,
            head: p.head?.ref ?? '',
            base: p.base?.ref ?? '',
            state: p.merged_at ? 'MERGED' : p.state === 'closed' ? 'CLOSED' : p.draft ? 'DRAFT' : 'OPEN',
            by: p.user?.login ?? '',
            created: Date.parse(p.created_at) / 1000,
            updated: Date.parse(p.updated_at) / 1000,
            merged: p.merged_at ? Date.parse(p.merged_at) / 1000 : null,
            // 没合并的 PR 也有 merge_commit_sha（GitHub 试合并出来的），不能算数
            mergeCommit: p.merged_at ? p.merge_commit_sha ?? null : null,
            url: p.html_url,
          })),
        };
        // 打开着的 PR 再问一次审核和 CI 状态
        try {
          const [owner, name] = slug.split('/');
          const d = await gh.graphql(token, OPEN_PR_CHECKS, { owner, name });
          const by = new Map((d.repository?.pullRequests?.nodes ?? []).map((x) => [x.number, x]));
          for (const p of value.list) {
            const x = by.get(p.n);
            if (!x) continue;
            p.review = x.reviewDecision || null;
            p.ci = ciSummary(x.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []);
          }
        } catch { /* 拿不到就不显示审核和 CI */ }
      } catch (e) {
        value = { available: false, reason: e.quiet ? e.message : 'GitHub：' + firstLine(e), list: [] };
      }
    }
    this.prCache = { at: Date.now(), value };
    return value;
  }
}

// 打开着的 PR：审核结论 + 最新一个提交上的检查（CI）
const OPEN_PR_CHECKS = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number
        reviewDecision
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name status conclusion }
          ... on StatusContext { context state }
        } } } } } }
      }
    }
  }
}`;

/** 把 GitHub 的检查列表归成一个状态：fail / pending / pass（没有检查返回 null），附上数量和失败的名字。 */
function ciSummary(list) {
  if (!list.length) return null;
  const BAD = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
  let pass = 0;
  let pending = 0;
  const failed = [];
  for (const c of list) {
    const concl = c.__typename === 'StatusContext' ? c.state : c.status === 'COMPLETED' ? c.conclusion : null;
    if (concl == null || concl === 'PENDING' || concl === 'EXPECTED') pending++;
    else if (BAD.has(concl)) failed.push(c.name ?? c.context ?? '?');
    else pass++;
  }
  return { state: failed.length ? 'fail' : pending ? 'pending' : 'pass', pass, pending, fail: failed.length, failed: failed.slice(0, 5), total: list.length };
}
