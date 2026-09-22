// 一个仓的所有查询。全部只读；唯一会动 .git 的是用户手动点的「同步远程」（git fetch）。
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { git, run, firstLine, checkRev, checkPath, EMPTY_TREE } from './git.mjs';
import { groupPeople, lookupAccounts } from './people.mjs';

const US = '\x1f';
const RS = '\x1e';
const MAX_COMMITS = 50000;
const MAX_PATCH = 4 * 1024 * 1024;
const MAX_BLOB = 8 * 1024 * 1024;
const PROD_NAMES = ['main', 'master', 'trunk', 'production', 'prod'];
const DEV_NAMES = ['dev', 'develop', 'development'];
const TEMP_DIRS = [tmpdir(), 'C:\\Temp', '/tmp'].map((d) => resolve(d).toLowerCase());

const isTemp = (p) => {
  const r = resolve(p).toLowerCase();
  return TEMP_DIRS.some((d) => r === d || r.startsWith(d + '\\') || r.startsWith(d + '/'));
};
const winPath = (p) => (process.platform === 'win32' ? p.replace(/\//g, '\\') : p);

/** numstat 里的路径：a/{b => c}/d 或 a => b，拆成 [旧, 新]。 */
function renamePaths(s) {
  if (!s.includes(' => ')) return [s, s];
  const m = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(s);
  if (m) {
    const fix = (x) => x.replace(/\/\//g, '/').replace(/^\//, '');
    return [fix(m[1] + m[2] + m[4]), fix(m[1] + m[3] + m[4])];
  }
  const [a, b] = s.split(' => ');
  return [a, b];
}

/** git diff-tree / diff 的 -z --numstat 与 -z --name-status，合成文件列表。 */
function parseChanges(numstat, nameStatus) {
  const files = [];
  const byPath = new Map();
  const t = nameStatus.split('\0');
  for (let i = 0; i < t.length - 1; ) {
    const code = t[i];
    if (!code) { i++; continue; }
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
    if (!path) { path = n[i + 2]; i += 2; }
    const f = byPath.get(path);
    if (!f) continue;
    if (m[1] === '-') f.bin = true;
    else { f.add = Number(m[1]); f.del = Number(m[2]); }
  }
  return files;
}

export class Repo {
  constructor(name, dir, ctx) {
    this.name = name;
    this.dir = dir;
    this.ctx = ctx; // { accounts, aliases, config }
    this.graphCache = null;
    this.prCache = null;
    this.statsCache = new Map();
    this.building = null;
  }

  async remoteInfo() {
    const url = (await git(this.dir, ['remote', 'get-url', 'origin']).catch(() => '')).trim();
    const slug = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? null;
    return { url, slug };
  }

  async fetchedAt() {
    const s = await stat(join(this.dir, '.git', 'FETCH_HEAD')).catch(() => null);
    return s ? Math.floor(s.mtimeMs / 1000) : null;
  }

  /** 首页用：一行概况。 */
  async summary() {
    const [head, last, { slug }, status, fetched, count] = await Promise.all([
      git(this.dir, ['branch', '--show-current']).catch(() => ''),
      git(this.dir, ['log', '-1', '--format=%ct%x1f%an%x1f%s', '--branches', '--remotes']).catch(() => ''),
      this.remoteInfo(),
      git(this.dir, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']).catch(() => null),
      this.fetchedAt(),
      git(this.dir, ['for-each-ref', '--format=x', 'refs/heads', 'refs/remotes', 'refs/tags']).catch(() => ''),
    ]);
    const [t, an, s] = last.trim().split(US);
    return {
      name: this.name,
      path: winPath(this.dir),
      slug,
      head: head.trim() || null,
      lastTime: Number(t) || null,
      lastAuthor: an ?? null,
      lastSubject: s ?? null,
      dirty: status == null ? null : status.split('\0').filter((x) => /^.. /.test(x)).length,
      refs: count.split('\n').filter(Boolean).length,
      fetchedAt: fetched,
    };
  }

  async listWorktrees() {
    const raw = await git(this.dir, ['worktree', 'list', '--porcelain']).catch(() => '');
    return raw.split(/\n\n+/).filter(Boolean).map((block, i) => {
      const w = { path: '', head: null, branch: null, main: i === 0, detached: false, prunable: false };
      for (const line of block.split('\n')) {
        const sp = line.indexOf(' ');
        const k = sp < 0 ? line : line.slice(0, sp);
        const v = sp < 0 ? '' : line.slice(sp + 1);
        if (k === 'worktree') w.path = v;
        else if (k === 'HEAD') w.head = v;
        else if (k === 'branch') w.branch = v.replace(/^refs\/heads\//, '');
        else if (k === 'detached') w.detached = true;
        else if (k === 'prunable') w.prunable = true;
        else if (k === 'bare') w.bare = true;
      }
      return { ...w, path: winPath(w.path), temp: !w.main && isTemp(w.path) };
    }).filter((w) => !w.bare);
  }

  /* ------------------------------------------------------------------ 提交图 */

  async graph() {
    const fmt = ['%(refname)', '%(objectname)', '%(*objectname)', '%(objecttype)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(creatordate:unix)', '%(symref)', '%(contents:subject)'].join('%1f') + '%1e';
    const [refsRaw, worktrees, originHead] = await Promise.all([
      git(this.dir, ['for-each-ref', '--format=' + fmt, 'refs/heads', 'refs/remotes', 'refs/tags']),
      this.listWorktrees(),
      git(this.dir, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']).catch(() => ''),
    ]);
    const key = refsRaw + '|' + worktrees.map((w) => w.path + ':' + w.head + ':' + w.branch).join('|');
    if (this.graphCache?.key === key) return this.graphCache.value;
    if (this.building?.key === key) return this.building.promise;
    const promise = this.buildGraph(refsRaw, worktrees, originHead.trim()).then((value) => {
      this.graphCache = { key, value };
      this.building = null;
      this.statsCache.clear();
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

    const extra = [...new Set(worktrees.filter((w) => w.detached && w.head).map((w) => w.head))];
    const logArgs = ['log', '--date-order', `--max-count=${MAX_COMMITS}`, '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%s', '--branches', '--remotes', '--tags'];
    let log;
    try {
      log = await git(this.dir, [...logArgs, ...extra, '--']);
    } catch {
      log = await git(this.dir, [...logArgs, '--']);
    }
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

    const { slug, url } = await this.remoteInfo();
    await lookupAccounts(this.ctx.accounts, slug, samples).catch(() => {});
    const { people, byPair } = groupPeople(pairs, this.ctx.accounts, this.ctx.aliases);
    commits.a = pairOf.map((pk) => byPair.get(pk));
    this.byPair = byPair;
    this.peopleList = people;

    const outRefs = refs.map((r) => ({ ...r, c: index.get(r.sha) ?? -1, sha: undefined })).filter((r) => r.c >= 0);
    const names = new Set(outRefs.filter((r) => r.k === 'L').map((r) => r.n));
    for (const r of outRefs) if (r.k === 'R' && r.remote === 'origin') names.add(r.short);
    const override = this.ctx.config.trunk?.[this.name] ?? {};
    const oh = originHead.replace(/^origin\//, '');
    const prod = override.prod ?? (oh && !DEV_NAMES.includes(oh) && names.has(oh) ? oh : PROD_NAMES.find((n) => names.has(n)) ?? null);
    const dev = override.dev ?? DEV_NAMES.find((n) => names.has(n) && n !== prod) ?? null;

    const current = worktrees.find((w) => w.main);
    return {
      name: this.name,
      path: winPath(this.dir),
      slug,
      url,
      fetchedAt: await this.fetchedAt(),
      generatedAt: Math.floor(Date.now() / 1000),
      trunk: { prod, dev },
      head: current?.branch ?? null,
      commits,
      truncated: lines.length >= MAX_COMMITS,
      refs: outRefs,
      worktrees: worktrees.map((w) => ({ path: w.path, branch: w.branch, c: w.head ? index.get(w.head) ?? -1 : -1, main: w.main, temp: w.temp, detached: w.detached, prunable: w.prunable })),
      people,
    };
  }

  personId(name, email) {
    return this.byPair?.get(name + '\0' + email) ?? -1;
  }
  async ensureGraph() {
    if (!this.byPair) await this.graph();
  }

  /* ------------------------------------------------------------------ 工作区 */

  async worktreeStatus() {
    const list = await this.listWorktrees();
    return Promise.all(list.map(async (w) => {
      if (w.prunable || !existsSync(w.path)) return { ...w, missing: true, files: [], total: 0 };
      const raw = await git(w.path, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']).catch(() => null);
      if (raw == null) return { ...w, missing: true, files: [], total: 0 };
      const out = { ...w, upstream: null, ahead: 0, behind: 0, files: [], total: 0 };
      const t = raw.split('\0');
      const files = [];
      for (let i = 0; i < t.length; i++) {
        const e = t[i];
        if (!e) continue;
        if (e.startsWith('# branch.upstream ')) out.upstream = e.slice(18);
        else if (e.startsWith('# branch.ab ')) {
          const m = /\+(\d+) -(\d+)/.exec(e);
          if (m) { out.ahead = Number(m[1]); out.behind = Number(m[2]); }
        } else if (e[0] === '1' || e[0] === '2') {
          const parts = e.split(' ');
          const xy = parts[1];
          const path = parts.slice(e[0] === '1' ? 8 : 9).join(' ');
          const f = { p: path, x: xy[0], y: xy[1] };
          if (e[0] === '2') { f.old = t[i + 1]; i++; }
          files.push(f);
        } else if (e[0] === 'u') {
          files.push({ p: e.split(' ').slice(10).join(' '), x: 'U', y: 'U', conflict: true });
        } else if (e[0] === '?') files.push({ p: e.slice(2), x: '?', y: '?' });
      }
      const numstat = new Map();
      if (files.length) {
        const ns = await git(w.path, ['diff', 'HEAD', '--numstat', '-z', '--no-renames']).catch(() => '');
        for (const rec of ns.split('\0')) {
          const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(rec);
          if (m) numstat.set(m[3], m[1] === '-' ? [null, null, true] : [Number(m[1]), Number(m[2]), false]);
        }
      }
      out.total = files.length;
      out.files = files.slice(0, 2000).map((f) => {
        const st = f.conflict ? 'C' : f.x === '?' ? 'U' : f.x === 'R' || f.y === 'R' ? 'R' : (f.y !== '.' ? f.y : f.x);
        const [add, del, bin] = numstat.get(f.p) ?? [null, null, false];
        return { p: f.p, old: f.old, st, staged: f.x !== '.' && f.x !== '?', unstaged: f.y !== '.' && f.y !== '?', add, del, bin };
      });
      return out;
    }));
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
    return this.patchResult(patch);
  }

  patchResult(patch) {
    if (patch.length > MAX_PATCH) return { tooLarge: true, size: patch.length };
    const binary = /^Binary files .* differ$/m.test(patch) && !/^@@/m.test(patch);
    return { patch: binary ? '' : patch, binary };
  }

  worktreeRoot(i) {
    return this.listWorktrees().then((list) => {
      const w = list[Number(i)];
      if (!w) throw Object.assign(new Error('没有这个工作树'), { status: 404 });
      return w;
    });
  }

  /** 工作树里一个文件的改动（相对 HEAD）；未跟踪的文件整篇算新增。 */
  async worktreeDiff({ wt, path, old, untracked, ws = false, ctx = 3 }) {
    checkPath(path);
    if (old) checkPath(old);
    const w = await this.worktreeRoot(wt);
    if (untracked) {
      const full = resolve(w.path, path);
      const rel = relative(w.path, full);
      if (rel.startsWith('..') || isAbsolute(rel)) throw Object.assign(new Error('路径越界'), { status: 400 });
      const s = await stat(full);
      if (s.isDirectory()) return { patch: '', binary: false, dir: true };
      if (s.size > MAX_BLOB) return { tooLarge: true, size: s.size };
      const buf = await readFile(full);
      if (buf.subarray(0, 8000).includes(0)) return { patch: '', binary: true };
      const lines = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n');
      if (lines.at(-1) === '') lines.pop();
      return { patch: `@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => '+' + l).join('\n') + '\n', binary: false };
    }
    const args = ['diff', '--no-color', '--no-ext-diff', '-M', `-U${Math.min(Number(ctx) || 3, 100000)}`];
    if (ws) args.push('-w');
    args.push('HEAD', '--', ...(old && old !== path ? [old, path] : [path]));
    return this.patchResult(await git(w.path, args));
  }

  /* ------------------------------------------------------------------ 文件 */

  async tree(ref) {
    checkRev(ref);
    const raw = await git(this.dir, ['ls-tree', '-r', '-l', '-z', '--full-tree', '--end-of-options', ref]);
    const files = [];
    for (const rec of raw.split('\0')) {
      if (!rec) continue;
      const tab = rec.indexOf('\t');
      const [mode, type, , size] = rec.slice(0, tab).split(/\s+/);
      files.push({ p: rec.slice(tab + 1), s: size === '-' ? null : Number(size), m: type === 'commit' ? 'sub' : mode === '120000' ? 'link' : mode === '100755' ? 'exe' : '' });
    }
    return { ref, files };
  }

  async blob(ref, path) {
    checkRev(ref);
    checkPath(path);
    const spec = `${ref}:${path}`;
    const size = Number((await git(this.dir, ['cat-file', '-s', spec])).trim());
    if (size > MAX_BLOB) return { size, tooLarge: true };
    const buf = await git(this.dir, ['cat-file', 'blob', spec], { buffer: true });
    return { size, buf, binary: buf.subarray(0, 8000).includes(0) };
  }

  async history(ref, path) {
    checkRev(ref);
    checkPath(path);
    await this.ensureGraph();
    const raw = await git(this.dir, ['log', '--follow', '-M', '--max-count=2000', '--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s', '--numstat', '--end-of-options', ref, '--', path]);
    const out = [];
    for (const chunk of raw.split(RS)) {
      if (!chunk.trim()) continue;
      const [head, ...rest] = chunk.split('\n');
      const [h, parents, an, ae, at, s] = head.split(US);
      let add = null;
      let del = null;
      let p = path;
      let old = null;
      for (const l of rest) {
        const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l);
        if (!m) continue;
        [old, p] = renamePaths(m[3]);
        if (old === p) old = null;
        if (m[1] !== '-') { add = Number(m[1]); del = Number(m[2]); }
      }
      out.push({ h, parent: parents ? parents.split(' ')[0] : null, a: this.personId(an, ae), an, t: Number(at), s, p, old, add, del });
    }
    return { ref, path, commits: out };
  }

  async blame(ref, path) {
    checkRev(ref);
    checkPath(path);
    await this.ensureGraph();
    const raw = await git(this.dir, ['blame', '--porcelain', ref, '--', path]);
    const commits = [];
    const idx = new Map();
    const lines = [];
    const text = [];
    let cur = null;
    let pending = {};
    for (const l of raw.split('\n')) {
      if (l.startsWith('\t')) {
        lines.push(idx.get(cur));
        text.push(l.slice(1));
        continue;
      }
      const m = /^([0-9a-f]{40}) \d+ \d+/.exec(l);
      if (m) {
        cur = m[1];
        if (!idx.has(cur)) {
          idx.set(cur, commits.length);
          pending = { h: cur, an: '', ae: '', t: 0, s: '', a: -1 };
          commits.push(pending);
        }
        continue;
      }
      const sp = l.indexOf(' ');
      const k = l.slice(0, sp);
      const v = l.slice(sp + 1);
      const c = commits[idx.get(cur)];
      if (!c) continue;
      if (k === 'author') c.an = v;
      else if (k === 'author-mail') c.ae = v.replace(/^<|>$/g, '');
      else if (k === 'author-time') c.t = Number(v);
      else if (k === 'summary') c.s = v;
      else if (k === 'previous') c.prev = v.split(' ')[0];
      else if (k === 'boundary') c.boundary = true;
    }
    for (const c of commits) {
      c.a = this.personId(c.an, c.ae);
      delete c.ae;
    }
    return { ref, path, commits, lines, text };
  }

  /* ------------------------------------------------------------------ 统计 */

  async stats(ref) {
    const g = await this.graph();
    const k = ref || '*';
    if (this.statsCache.has(k)) return this.statsCache.get(k);
    const revs = ref ? ['--end-of-options', checkRev(ref)] : ['--branches', '--remotes', '--tags'];
    const raw = await git(this.dir, ['log', '--no-merges', '--no-renames', '--format=%x1e%H%x1f%an%x1f%ae%x1f%at', '--numstat', ...revs, '--']);
    const commits = { h: [], a: [], t: [], add: [], del: [], f: [] };
    const files = new Map();
    for (const chunk of raw.split(RS)) {
      if (!chunk.trim()) continue;
      const [head, ...rest] = chunk.split('\n');
      const [h, an, ae, at] = head.split(US);
      const a = this.personId(an, ae);
      const t = Number(at);
      let add = 0;
      let del = 0;
      let n = 0;
      for (const l of rest) {
        const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l);
        if (!m) continue;
        n++;
        const fa = m[1] === '-' ? 0 : Number(m[1]);
        const fd = m[2] === '-' ? 0 : Number(m[2]);
        add += fa;
        del += fd;
        let f = files.get(m[3]);
        if (!f) files.set(m[3], (f = { p: m[3], n: 0, add: 0, del: 0, last: 0, by: new Map() }));
        f.n++;
        f.add += fa;
        f.del += fd;
        if (t > f.last) f.last = t;
        f.by.set(a, (f.by.get(a) ?? 0) + 1);
      }
      commits.h.push(h.slice(0, 12));
      commits.a.push(a);
      commits.t.push(t);
      commits.add.push(add);
      commits.del.push(del);
      commits.f.push(n);
    }
    const all = [...files.values()];
    const hot = all.sort((x, y) => y.n - x.n || y.last - x.last).slice(0, 200).map((f) => ({ p: f.p, n: f.n, add: f.add, del: f.del, last: f.last, by: [...f.by].sort((x, y) => y[1] - x[1]).slice(0, 5) }));
    const byPerson = {};
    for (const f of all) {
      for (const [a, n] of f.by) {
        (byPerson[a] ??= []).push([f.p, n]);
      }
    }
    for (const a of Object.keys(byPerson)) byPerson[a] = byPerson[a].sort((x, y) => y[1] - x[1]).slice(0, 12);
    const value = { ref: ref || null, generatedAt: g.generatedAt, commits, files: hot, personFiles: byPerson };
    this.statsCache.set(k, value);
    return value;
  }

  /* ------------------------------------------------------------------ PR / 同步 */

  async prs(refresh = false) {
    if (!refresh && this.prCache && Date.now() - this.prCache.at < 5 * 60 * 1000) return this.prCache.value;
    const { slug } = await this.remoteInfo();
    if (!slug) return { available: false, reason: '不是 GitHub 仓库', list: [] };
    const fields = 'number,title,headRefName,baseRefName,state,isDraft,author,createdAt,updatedAt,mergedAt,url,mergeCommit';
    let value;
    try {
      const out = await run('gh', ['pr', 'list', '-R', slug, '--state', 'all', '--limit', '500', '--json', fields], { timeout: 30000 });
      value = {
        available: true,
        list: JSON.parse(out).map((p) => ({
          n: p.number,
          title: p.title,
          head: p.headRefName,
          base: p.baseRefName,
          state: p.isDraft && p.state === 'OPEN' ? 'DRAFT' : p.state,
          by: p.author?.login ?? '',
          created: Date.parse(p.createdAt) / 1000,
          updated: Date.parse(p.updatedAt) / 1000,
          merged: p.mergedAt ? Date.parse(p.mergedAt) / 1000 : null,
          mergeCommit: p.mergeCommit?.oid ?? null,
          url: p.url,
        })),
      };
    } catch (e) {
      value = { available: false, reason: 'gh：' + firstLine(e), list: [] };
    }
    this.prCache = { at: Date.now(), value };
    return value;
  }

  async fetch() {
    try {
      await git(this.dir, ['fetch', '--all', '--prune', '--quiet']);
      this.prCache = null;
      return { ok: true, fetchedAt: await this.fetchedAt() };
    } catch (e) {
      return { ok: false, error: firstLine(e), fetchedAt: await this.fetchedAt() };
    }
  }
}
