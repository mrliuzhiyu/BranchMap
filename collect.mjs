// 分支地图的数据采集：扫一遍根目录下的每个 Git 仓，把分支、提交、PR 与未提交的文件写成 data.js 给 index.html 读。
// 只读：除了 git fetch 更新远程分支之外，不碰任何工作树，不切分支。
//
// 用法：node collect.mjs [--root=<放仓库的目录>] [--no-fetch]
// 根目录也可以写在 config.json 的 root 里（见 config.example.json）。
// 同一个人用了几个 Git 名字时，在 aliases.json 里写 { "显示名": ["名字1", "名字2"] }。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const configFile = join(here, 'config.json');
const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {};
const rootArg = arg('root') ?? config.root;
if (!rootArg) {
  console.error('不知道去哪找仓库：用 --root=<目录> 指定，或者照 config.example.json 写一份 config.json');
  process.exit(1);
}
const root = resolve(rootArg);
const fetchRemote = !process.argv.includes('--no-fetch');
const SEP = '\x1f';
const opts = { maxBuffer: 512 * 1024 * 1024, windowsHide: true };

const git = (dir, args) =>
  exec('git', ['--no-optional-locks', '-C', dir, '-c', 'core.quotepath=off', ...args], opts).then((r) => r.stdout);
const firstLine = (e) => String(e?.stderr || e?.message || e).trim().split('\n')[0];

const isRepo = (dir) => {
  try {
    return statSync(join(dir, '.git')).isDirectory();
  } catch {
    return false;
  }
};

// 同一个人：同一个邮箱、大小写不同的同名、aliases.json 里写在一起的，都并成一个人。
const uf = new Map();
const find = (x) => {
  if (!uf.has(x)) uf.set(x, x);
  let r = x;
  while (uf.get(r) !== r) r = uf.get(r);
  uf.set(x, r);
  return r;
};
const union = (a, b) => {
  const ra = find(a);
  const rb = find(b);
  if (ra !== rb) uf.set(rb, ra);
};
const GENERIC_EMAIL = /^(no-?reply|noreply|root|admin|dev|developer)@|@(localhost|example\.com)$/i;
const nameKey = (n) => 'n:' + n.trim().toLowerCase();

const aliasFile = join(here, 'aliases.json');
const aliases = existsSync(aliasFile) ? JSON.parse(readFileSync(aliasFile, 'utf8')) : {};
for (const [display, names] of Object.entries(aliases)) for (const n of names) union(nameKey(display), nameKey(n));

const samples = new Map();

// 这个仓的每个工作树：检出的分支、和上游差几个提交、没提交的文件（含增删行数）。
async function collectWorktrees(dir) {
  const raw = await git(dir, ['worktree', 'list', '--porcelain']).catch(() => '');
  const list = raw.split(/\n\n+/).filter(Boolean).map((block) => {
    const kv = Object.fromEntries(block.split('\n').map((l) => [l.split(' ')[0], l.slice(l.indexOf(' ') + 1)]));
    return { path: kv.worktree, branch: kv.branch?.replace('refs/heads/', '') ?? null };
  });
  const out = await Promise.all(
    list.map(async (w, i) => {
      if (!w.path || !existsSync(w.path)) return null;
      const status = await git(w.path, ['status', '--porcelain=v1', '-b']).catch(() => null);
      if (status === null) return null;
      const lines = status.split('\n').filter(Boolean);
      const head = lines[0]?.startsWith('## ') ? lines.shift() : '';
      const ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0);
      const behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0);
      const numstat = new Map();
      if (lines.length) {
        const ns = await git(w.path, ['diff', 'HEAD', '--numstat']).catch(() => '');
        for (const l of ns.split('\n').filter(Boolean)) {
          const [a, d, p] = l.split('\t');
          numstat.set(p, [a === '-' ? null : Number(a), d === '-' ? null : Number(d)]);
        }
      }
      const files = lines.slice(0, 400).map((l) => {
        const x = l[0];
        const y = l[1];
        let p = l.slice(3);
        if (p.includes(' -> ')) p = p.split(' -> ')[1];
        p = p.replace(/^"|"$/g, '');
        const code = x === '?' ? 'U' : y !== ' ' ? y : x;
        const [add, del] = numstat.get(p) ?? [null, null];
        return { c: code, p, s: x !== ' ' && x !== '?' ? 1 : 0, a: add, d: del };
      });
      return { path: w.path.replace(/\//g, '\\'), main: i === 0, branch: w.branch, ahead, behind, total: lines.length, files };
    }),
  );
  return out.filter(Boolean);
}

async function collectRepo(name) {
  const dir = join(root, name);
  const warnings = [];
  if (fetchRemote) await git(dir, ['fetch', '--prune', '--quiet', 'origin']).catch((e) => warnings.push('fetch：' + firstLine(e)));

  const url = (await git(dir, ['remote', 'get-url', 'origin']).catch(() => '')).trim();
  const slug = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1] ?? null;

  const branches = new Map();
  const branch = (n) => {
    if (!branches.has(n)) branches.set(n, { n, local: null, remote: null, track: '' });
    return branches.get(n);
  };
  const refs = await git(dir, [
    'for-each-ref',
    '--format=%(refname)%1f%(objectname)%1f%(upstream:track,nobracket)',
    'refs/heads',
    'refs/remotes/origin',
  ]);
  for (const line of refs.split('\n').filter(Boolean)) {
    const [ref, sha, track] = line.split(SEP);
    if (ref.startsWith('refs/heads/')) Object.assign(branch(ref.slice(11)), { local: sha, track });
    else if (ref !== 'refs/remotes/origin/HEAD') branch(ref.slice('refs/remotes/origin/'.length)).remote = sha;
  }

  const log = await git(dir, [
    '-c',
    'i18n.logOutputEncoding=utf-8',
    'log',
    '--branches',
    '--remotes=origin/*',
    '--date-order',
    '--format=%H%x1f%P%x1f%ct%x1f%an%x1f%ae%x1f%s',
  ]);
  const rows = log.split('\n').filter(Boolean).map((l) => l.split(SEP));
  const index = new Map(rows.map((r, i) => [r[0], i]));
  const commits = { h: [], p: [], t: [], a: [], s: [] };
  for (const [sha, parents, time, an, ae, subject] of rows) {
    const nk = nameKey(an);
    find(nk);
    if (ae && !GENERIC_EMAIL.test(ae)) union(nk, 'e:' + ae.toLowerCase());
    // 每个「名字+邮箱」留几个提交，稍后去 GitHub 问它对应哪个账号（头像从那来）
    const pk = an + '\0' + ae;
    const cand = samples.get(pk) ?? (samples.set(pk, { an, list: [] }), samples.get(pk));
    if (slug && cand.list.length < 3) cand.list.push({ slug, sha });
    commits.h.push(sha.slice(0, 10));
    commits.p.push(parents ? parents.split(' ').map((q) => index.get(q) ?? -1).filter((q) => q >= 0) : []);
    commits.t.push(Number(time));
    commits.a.push(an);
    commits.s.push(subject.length > 200 ? subject.slice(0, 199) + '…' : subject);
  }

  const originHead = (await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim().replace(/^origin\//, '');
  const prod = originHead && originHead !== 'dev' ? originHead : ['main', 'master'].find((n) => branches.has(n)) ?? null;
  const dev = branches.has('dev') ? 'dev' : null;

  const current = (await git(dir, ['branch', '--show-current']).catch(() => '')).trim();
  const worktrees = await collectWorktrees(dir);

  let prs = [];
  if (slug) {
    try {
      const args = ['pr', 'list', '-R', slug, '--state', 'all', '--limit', '400', '--json', 'number,title,headRefName,baseRefName,state,isDraft,author,updatedAt,mergedAt,url'];
      const { stdout } = await exec('gh', args, opts).catch(() => exec('gh', args, opts)); // 网络偶尔断一下，重试一次
      prs = JSON.parse(stdout).map((p) => ({
        n: p.number,
        title: p.title,
        head: p.headRefName,
        base: p.baseRefName,
        state: p.isDraft && p.state === 'OPEN' ? 'DRAFT' : p.state,
        by: p.author?.login ?? '',
        updated: Date.parse(p.updatedAt) / 1000,
        merged: p.mergedAt ? Date.parse(p.mergedAt) / 1000 : null,
        url: p.url,
      }));
    } catch (e) {
      warnings.push('gh：' + firstLine(e));
    }
  }

  const at = (sha) => (sha ? index.get(sha) ?? -1 : -1);
  return {
    name,
    slug,
    prod,
    dev,
    current,
    worktrees,
    branches: [...branches.values()].map((b) => ({ n: b.n, l: at(b.local), r: at(b.remote), k: b.track })),
    commits,
    prs,
    warnings,
  };
}

const names = readdirSync(root).filter((n) => isRepo(join(root, n)));
const started = Date.now();
const repos = await Promise.all(names.map(collectRepo));

// 问 GitHub：每个「名字+邮箱」的提交挂在哪个账号上。一次 GraphQL 查完；
// 挂在同一个账号上的名字就是同一个人，账号的头像就是这个人的头像。
const accounts = new Map();
{
  const byRepo = new Map();
  let n = 0;
  const alias = [];
  for (const [pk, { list }] of samples) {
    for (const { slug, sha } of list) {
      if (!byRepo.has(slug)) byRepo.set(slug, []);
      const key = 'c' + n++;
      byRepo.get(slug).push(`${key}: object(oid: "${sha}") { ... on Commit { author { user { login avatarUrl(size: 96) } } } }`);
      alias.push([key, pk]);
    }
  }
  const query =
    'query {' +
    [...byRepo].map(([slug, fields], i) => {
      const [owner, repo] = slug.split('/');
      return ` r${i}: repository(owner: "${owner}", name: "${repo}") { ${fields.join(' ')} }`;
    }).join('') +
    ' }';
  try {
    // 个别提交没推上去时 GraphQL 会带着 errors 退出非零，但 data 里其余结果照样可用
    const stdout = await exec('gh', ['api', 'graphql', '-f', `query=${query}`], opts).then((r) => r.stdout, (e) => { if (e.stdout) return e.stdout; throw e; });
    const found = new Map();
    for (const repo of Object.values(JSON.parse(stdout).data ?? {})) {
      for (const [key, obj] of Object.entries(repo ?? {})) if (obj?.author?.user) found.set(key, obj.author.user);
    }
    for (const [key, pk] of alias) {
      const user = found.get(key);
      if (!user || accounts.has(pk)) continue;
      accounts.set(pk, user);
      union(nameKey(samples.get(pk).an), 'gh:' + user.login.toLowerCase());
    }
  } catch (e) {
    console.warn('GitHub 账号查询失败，头像退回首字：' + firstLine(e));
  }
}

// 人：每组取出现次数最多的名字当显示名，aliases.json 里写的显示名优先。
const count = new Map();
for (const r of repos) for (const an of r.commits.a) count.set(an, (count.get(an) ?? 0) + 1);
const groups = new Map();
for (const [an, c] of count) {
  const root = find(nameKey(an));
  if (!groups.has(root)) groups.set(root, []);
  groups.get(root).push([an, c]);
}
const people = [];
const personOf = new Map();
for (const members of groups.values()) {
  members.sort((x, y) => y[1] - x[1]);
  const display = Object.keys(aliases).find((d) => members.some(([an]) => find(nameKey(an)) === find(nameKey(d))));
  const id = people.length;
  const names = new Set(members.map(([an]) => an));
  const account = [...samples].find(([pk, s]) => names.has(s.an) && accounts.has(pk));
  const user = account ? accounts.get(account[0]) : null;
  people.push({
    name: display ?? members[0][0],
    names: [...names],
    commits: members.reduce((s, [, c]) => s + c, 0),
    login: user?.login ?? null,
    avatar: user?.avatarUrl ?? null,
  });
  for (const [an] of members) personOf.set(an, id);
}
for (const r of repos) r.commits.a = r.commits.a.map((an) => personOf.get(an));

const data = { generatedAt: Math.floor(Date.now() / 1000), root, people, repos };
writeFileSync(join(here, 'data.js'), 'window.BRANCH_MAP_DATA = ' + JSON.stringify(data) + ';\n');

for (const r of repos) {
  console.log(`${r.name.padEnd(22)} 分支 ${String(r.branches.length).padStart(3)}  提交 ${String(r.commits.h.length).padStart(5)}  PR ${String(r.prs.length).padStart(3)}  ${r.warnings.join('；')}`);
}
const merged = people.filter((p) => p.names.length > 1).map((p) => `${p.name}=${p.names.join('/')}`);
console.log(`人 ${people.length}，有头像 ${people.filter((p) => p.avatar).length}${merged.length ? '（已合并：' + merged.join('，') + '）' : ''}`);
for (const r of repos) for (const w of r.worktrees) if (w.total) console.log(`  未提交 ${String(w.total).padStart(3)}  ${w.path}`);
console.log(`用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
