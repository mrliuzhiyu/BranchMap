// 本机：扫描目录里的仓库和它们的所有工作树，按远程地址归到项目下。
// 只回答「我这台电脑上的东西推上去了没有」：未推送的提交、没拉下来的更新、没提交的改动、stash。
// 和云端比较时用的是 BranchMap 自己的云端副本，不去本机仓库里 fetch——本机仓库只读不写。
import { existsSync, statSync, readdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { git, checkPath } from '../git.mjs';
import { remoteKey } from '../remote.mjs';

const US = '\x1f';
const MAX_FILES = 2000;
const MAX_BLOB = 8 * 1024 * 1024;
const MAX_PATCH = 4 * 1024 * 1024;
const TEMP_DIRS = [tmpdir(), 'C:\\Temp', '/tmp'].map((d) => resolve(d).toLowerCase());

export const winPath = (p) => (process.platform === 'win32' ? p.replace(/\//g, '\\') : p);
const isTemp = (p) => {
  const r = resolve(p).toLowerCase();
  return TEMP_DIRS.some((d) => r === d || r.startsWith(d + '\\') || r.startsWith(d + '/'));
};
const hasGit = (dir) => {
  try {
    statSync(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
};
const normDir = (p) => resolve(p).toLowerCase();

export class LocalScanner {
  constructor({ roots, extra }) {
    this.roots = roots;
    this.extra = extra;
    this.byKey = new Map(); // 远程键 -> { url, repos: [...] }
    this.unmatched = []; // 没有远程的仓库
    this.scannedAt = 0;
  }

  /** 找出所有仓库，按远程归组。 */
  async discover() {
    const dirs = [];
    for (const root of this.roots) {
      if (!existsSync(root)) continue;
      if (hasGit(root)) dirs.push(root);
      else {
        for (const n of readdirSync(root).sort()) {
          const d = join(root, n);
          if (hasGit(d)) dirs.push(d);
        }
      }
    }
    for (const d of this.extra) if (hasGit(d)) dirs.push(d);

    // 同一个 .git（主仓库和它的工作树）只算一份
    const repos = new Map();
    await Promise.all(dirs.map(async (dir) => {
      const common = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).then((s) => s.trim()).catch(() => null);
      if (!common) return;
      const k = normDir(common);
      if (!repos.has(k)) repos.set(k, { gitDir: winPath(common), dirs: [] });
      repos.get(k).dirs.push(dir);
    }));

    const byKey = new Map();
    const unmatched = [];
    await Promise.all([...repos.values()].map(async (r) => {
      const cwd = r.dirs[0];
      const remotes = await git(cwd, ['config', '--get-regexp', '^remote\\..*\\.url$']).catch(() => '');
      const urls = new Map();
      for (const line of remotes.split('\n')) {
        const m = /^remote\.(.+)\.url\s+(.+)$/.exec(line.trim());
        if (m) urls.set(m[1], m[2]);
      }
      const remoteName = urls.has('origin') ? 'origin' : urls.keys().next().value;
      const url = remoteName ? urls.get(remoteName) : null;
      const key = remoteKey(url);
      const worktrees = await listWorktrees(cwd);
      const repo = { gitDir: r.gitDir, remoteName, url, worktrees, name: basename(worktrees.find((w) => w.main)?.path ?? cwd) };
      if (!key) {
        unmatched.push(repo);
        return;
      }
      if (!byKey.has(key)) byKey.set(key, { url, repos: [] });
      byKey.get(key).repos.push(repo);
    }));
    for (const v of byKey.values()) v.repos.sort((a, b) => a.gitDir.localeCompare(b.gitDir));
    this.byKey = byKey;
    this.unmatched = unmatched;
    this.scannedAt = Date.now();
    return byKey;
  }

  /** 本机上这个远程的所有 git 目录（给云端副本做种子用）。 */
  seedsFor(key) {
    return (this.byKey.get(key)?.repos ?? []).map((r) => r.gitDir);
  }
  checkoutPaths(key) {
    return (this.byKey.get(key)?.repos ?? []).flatMap((r) => r.worktrees.filter((w) => !w.prunable && !w.bare).map((w) => w.path));
  }

  /**
   * 一个项目在本机的完整状态。G：云端副本的提交图（CommitGraph），用来判断提交有没有推上去。
   * 返回 { repos, checkouts, branches, stashes }
   */
  async status(key, G) {
    const entry = this.byKey.get(key);
    if (!entry) return { repos: [], checkouts: [], branches: [], stashes: 0, scannedAt: Date.now() };
    const repos = [];
    const checkouts = [];
    const branches = [];
    let stashes = 0;
    await Promise.all(entry.repos.map(async (repo, ri) => {
      const cwd = repo.worktrees.find((w) => w.main && !w.bare && existsSync(w.path))?.path ?? repo.gitDir;
      const [refs, stash] = await Promise.all([
        git(cwd, ['for-each-ref', '--format=%(refname:short)%1f%(objectname)%1f%(upstream:short)%1f%(committerdate:unix)%1f%(authorname)%1f%(contents:subject)', 'refs/heads']).catch(() => ''),
        git(cwd, ['rev-list', '--walk-reflogs', '--count', 'refs/stash']).then((s) => Number(s.trim()) || 0).catch(() => 0),
      ]);
      stashes += stash;
      repos[ri] = { gitDir: repo.gitDir, name: repo.name, url: repo.url, stashes: stash };
      const heads = new Map();
      for (const line of refs.split('\n')) {
        if (!line) continue;
        const [name, sha, upstream, ct, an, subject] = line.split(US);
        heads.set(name, { name, sha, upstream: upstream || null, time: Number(ct), author: an, subject });
      }
      // 每条本地分支和云端比
      await Promise.all([...heads.values()].map(async (b) => {
        const cloudName = b.upstream && repo.remoteName && b.upstream.startsWith(repo.remoteName + '/') ? b.upstream.slice(repo.remoteName.length + 1) : b.upstream ? null : b.name;
        const cmp = await compareWithCloud(cwd, b.sha, cloudName, G);
        branches.push({ repo: ri, name: b.name, sha: b.sha, time: b.time, author: b.author, subject: b.subject, upstream: b.upstream, cloudName, ...cmp, checkedOut: [] });
      }));
      // 工作树
      await Promise.all(repo.worktrees.map(async (w) => {
        if (w.bare) return;
        const co = { repo: ri, path: w.path, name: basename(w.path), branch: w.branch, head: w.head, detached: w.detached, main: w.main, temp: !w.main && isTemp(w.path), prunable: w.prunable, missing: false };
        if (w.prunable || !existsSync(w.path)) {
          co.missing = true;
          co.files = [];
          co.total = 0;
        } else {
          Object.assign(co, await readStatus(w.path));
        }
        checkouts.push(co);
      }));
    }));
    // 分支 ↔ 检出它的工作树
    checkouts.sort((a, b) => a.repo - b.repo || (b.main - a.main) || a.path.localeCompare(b.path));
    checkouts.forEach((c, i) => (c.id = i));
    for (const c of checkouts) {
      if (!c.branch) {
        if (c.head && G) {
          const idx = G.index.get(c.head);
          c.inCloud = idx !== undefined;
        }
        continue;
      }
      const b = branches.find((x) => x.repo === c.repo && x.name === c.branch);
      if (b) {
        b.checkedOut.push(c.id);
        c.cloud = { cloudName: b.cloudName, unpushed: b.unpushed, behind: b.behind, cloudExists: b.cloudExists, pushed: b.pushed };
      }
    }
    branches.sort((a, b) => b.time - a.time);
    return { repos, checkouts, branches, stashes, scannedAt: Date.now() };
  }

  /** 工作树里一个文件的改动（相对 HEAD）；未跟踪的文件整篇算新增。 */
  async worktreeDiff(path, { file, old, untracked, ws = false, ctx = 3 }) {
    checkPath(file);
    if (old) checkPath(old);
    if (untracked) {
      const full = resolve(path, file);
      const rel = relative(path, full);
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
    args.push('HEAD', '--', ...(old && old !== file ? [old, file] : [file]));
    const patch = await git(path, args);
    if (patch.length > MAX_PATCH) return { tooLarge: true, size: patch.length };
    const binary = /^Binary files .* differ$/m.test(patch) && !/^@@/m.test(patch);
    return { patch: binary ? '' : patch, binary };
  }
}

async function listWorktrees(cwd) {
  const raw = await git(cwd, ['worktree', 'list', '--porcelain']).catch(() => '');
  return raw.split(/\n\n+/).filter(Boolean).map((block, i) => {
    const w = { path: '', head: null, branch: null, main: i === 0, detached: false, prunable: false, bare: false };
    for (const line of block.split('\n')) {
      const sp = line.indexOf(' ');
      const k = sp < 0 ? line : line.slice(0, sp);
      const v = sp < 0 ? '' : line.slice(sp + 1);
      if (k === 'worktree') w.path = winPath(v);
      else if (k === 'HEAD') w.head = v;
      else if (k === 'branch') w.branch = v.replace(/^refs\/heads\//, '');
      else if (k === 'detached') w.detached = true;
      else if (k === 'prunable') w.prunable = true;
      else if (k === 'bare') w.bare = true;
    }
    return w;
  });
}

/**
 * 一条本地分支和云端比：
 *  unpushed —— 云端（任何分支）都没有的提交数；
 *  behind   —— 云端同名分支有、本地没有的提交数（没拉取）；
 *  pushed   —— 分支头在云端存在（全部推上去了）；
 *  cloudExists —— 云端有没有对应的分支。
 */
async function compareWithCloud(cwd, sha, cloudName, G) {
  if (!G) return { unpushed: null, behind: null, pushed: null, cloudExists: null };
  const cloudTip = cloudName ? G.branchTip(cloudName) : -1;
  const cloudExists = cloudTip >= 0;
  const own = G.index.get(sha);
  if (own !== undefined) {
    return {
      unpushed: 0,
      pushed: true,
      cloudExists,
      behind: cloudExists ? G.countDiff(G.anc(cloudTip), G.anc(own)) : null,
      // 已推到云端、但不在云端同名分支上的提交（比如本地把 dev 合进了 main 还没推）
      notOnCloudBranch: cloudExists ? G.countDiff(G.anc(own), G.anc(cloudTip)) : null,
    };
  }
  // 分支头不在云端：找出本地独有的提交，和它们在云端的「落脚点」
  let raw = await git(cwd, ['rev-list', '--parents', '--max-count=3000', sha, '--not', '--remotes', '--']).catch(() => '');
  if (!raw.trim()) raw = await git(cwd, ['rev-list', '--parents', '--max-count=3000', sha, '--']).catch(() => '');
  let unpushed = 0;
  const boundary = new Set();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [c, ...parents] = line.split(' ');
    const ci = G.index.get(c);
    if (ci !== undefined) {
      boundary.add(ci);
      continue;
    }
    unpushed++;
    for (const p of parents) {
      const pi = G.index.get(p);
      if (pi !== undefined) boundary.add(pi);
    }
  }
  const base = boundary.size ? G.union([...boundary]) : null;
  return {
    unpushed,
    pushed: false,
    cloudExists,
    behind: cloudExists && base ? G.countDiff(G.anc(cloudTip), base) : cloudExists ? null : null,
    notOnCloudBranch: null,
  };
}

/** git status：分支、上游、改动的文件。 */
export async function readStatus(path) {
  const raw = await git(path, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']).catch(() => null);
  if (raw == null) return { missing: true, files: [], total: 0 };
  const out = { upstream: null, ahead: 0, behind: 0, files: [], total: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
  const t = raw.split('\0');
  const files = [];
  for (let i = 0; i < t.length; i++) {
    const e = t[i];
    if (!e) continue;
    if (e.startsWith('# branch.upstream ')) out.upstream = e.slice(18);
    else if (e.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(e);
      if (m) {
        out.ahead = Number(m[1]);
        out.behind = Number(m[2]);
      }
    } else if (e[0] === '1' || e[0] === '2') {
      const parts = e.split(' ');
      const xy = parts[1];
      const p = parts.slice(e[0] === '1' ? 8 : 9).join(' ');
      const f = { p, x: xy[0], y: xy[1] };
      if (e[0] === '2') {
        f.old = t[i + 1];
        i++;
      }
      files.push(f);
    } else if (e[0] === 'u') files.push({ p: e.split(' ').slice(10).join(' '), x: 'U', y: 'U', conflict: true });
    else if (e[0] === '?') files.push({ p: e.slice(2), x: '?', y: '?' });
  }
  const numstat = new Map();
  if (files.length && files.length <= MAX_FILES) {
    const ns = await git(path, ['diff', 'HEAD', '--numstat', '-z', '--no-renames']).catch(() => '');
    for (const rec of ns.split('\0')) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(rec);
      if (m) numstat.set(m[3], m[1] === '-' ? [null, null, true] : [Number(m[1]), Number(m[2]), false]);
    }
  }
  out.total = files.length;
  for (const f of files) {
    if (f.conflict) out.conflicts++;
    else if (f.x === '?') out.untracked++;
    else {
      if (f.x !== '.') out.staged++;
      if (f.y !== '.') out.unstaged++;
    }
  }
  out.files = files.slice(0, MAX_FILES).map((f) => {
    const st = f.conflict ? 'C' : f.x === '?' ? 'U' : f.x === 'R' || f.y === 'R' ? 'R' : f.y !== '.' ? f.y : f.x;
    const [add, del, bin] = numstat.get(f.p) ?? [null, null, false];
    return { p: f.p, old: f.old, st, staged: f.x !== '.' && f.x !== '?', unstaged: f.y !== '.' && f.y !== '?', add, del, bin };
  });
  return out;
}
