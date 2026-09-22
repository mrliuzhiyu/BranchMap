// BranchMap 本机服务：按需跑只读的 git 命令，给 web/ 里的页面用。
// 只监听 127.0.0.1；除了用户手动点的「同步远程」（git fetch）之外，不改任何仓库。
//
// 用法：node server.mjs [--root=<放仓库的目录>] [--port=4317] [--open]
// 根目录也可以写在 config.json 的 root 里（见 config.example.json）。
import http from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname, resolve, extname, basename, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { Repo } from './lib/repo.mjs';
import { Accounts } from './lib/people.mjs';
import { firstLine } from './lib/git.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const readJson = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {});
const config = readJson(join(here, 'config.json'));
const aliases = readJson(join(here, 'aliases.json'));
const roots = [arg('root') ?? config.root].flat().filter(Boolean).map((r) => resolve(r));
const extraRepos = (config.repos ?? []).map((r) => resolve(r));
if (!roots.length && !extraRepos.length) {
  console.error('不知道去哪找仓库：用 --root=<目录> 指定，或者照 config.example.json 写一份 config.json');
  process.exit(1);
}
const PORT = Number(arg('port') ?? config.port ?? 4317);
const HOST = '127.0.0.1';
const ctx = { accounts: new Accounts(join(here, '.cache')), aliases, config };

/* ---------- 仓库 ---------- */
const repos = new Map();
const isRepo = (dir) => {
  try {
    return statSync(join(dir, '.git')).isDirectory();
  } catch {
    return false;
  }
};
function discover() {
  const dirs = [];
  for (const root of roots) {
    if (isRepo(root)) dirs.push(root);
    else for (const n of readdirSync(root).sort()) if (isRepo(join(root, n))) dirs.push(join(root, n));
  }
  for (const d of extraRepos) if (isRepo(d)) dirs.push(d);
  const seen = new Set();
  for (const dir of dirs) {
    let name = basename(dir);
    for (let i = 2; seen.has(name); i++) name = `${basename(dir)}-${i}`;
    seen.add(name);
    if (!repos.has(name) || repos.get(name).dir !== dir) repos.set(name, new Repo(name, dir, ctx));
  }
  for (const name of [...repos.keys()]) if (!seen.has(name)) repos.delete(name);
  return [...repos.values()];
}
discover();

/* ---------- 路由 ---------- */
const routes = [
  ['GET', /^\/api\/repos$/, async () => Promise.all(discover().map((r) => r.summary()))],
  ['GET', /^\/api\/r\/([^/]+)\/graph$/, async (r) => {
    const g = await r.graph();
    // 统计和 PR 第一次要好几秒，趁用户还在看提交图时先在后台算好
    setTimeout(() => {
      r.stats(null).catch(() => {});
      r.prs().catch(() => {});
    }, 50);
    return g;
  }],
  ['GET', /^\/api\/r\/([^/]+)\/worktrees$/, (r) => r.worktreeStatus()],
  ['GET', /^\/api\/r\/([^/]+)\/prs$/, (r, q) => r.prs(q.get('refresh') === '1')],
  ['POST', /^\/api\/r\/([^/]+)\/fetch$/, (r) => r.fetch()],
  ['GET', /^\/api\/r\/([^/]+)\/commit\/([0-9a-f]{7,40})$/, (r, q, m) => r.commit(m[2], Number(q.get('parent') ?? 1))],
  ['GET', /^\/api\/r\/([^/]+)\/compare$/, (r, q) => r.compare(q.get('base'), q.get('head'))],
  ['GET', /^\/api\/r\/([^/]+)\/diff$/, (r, q) => r.diff({ from: q.get('from'), to: q.get('to'), path: q.get('path'), old: q.get('old'), ctx: q.get('ctx'), ws: q.get('ws') === '1' })],
  ['GET', /^\/api\/r\/([^/]+)\/wtdiff$/, (r, q) => r.worktreeDiff({ wt: q.get('wt'), path: q.get('path'), old: q.get('old'), untracked: q.get('untracked') === '1', ctx: q.get('ctx'), ws: q.get('ws') === '1' })],
  ['GET', /^\/api\/r\/([^/]+)\/tree$/, (r, q) => r.tree(q.get('ref'))],
  ['GET', /^\/api\/r\/([^/]+)\/blob$/, blobRoute],
  ['GET', /^\/api\/r\/([^/]+)\/history$/, (r, q) => r.history(q.get('ref'), q.get('path'))],
  ['GET', /^\/api\/r\/([^/]+)\/blame$/, (r, q) => r.blame(q.get('ref'), q.get('path'))],
  ['GET', /^\/api\/r\/([^/]+)\/stats$/, (r, q) => r.stats(q.get('ref') || null)],
];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.avif': 'image/avif',
};

async function blobRoute(r, q, m, res) {
  const b = await r.blob(q.get('ref'), q.get('path'));
  if (q.get('raw') === '1') {
    if (b.tooLarge) throw Object.assign(new Error('文件太大'), { status: 413 });
    const type = MIME[extname(q.get('path')).toLowerCase()];
    // 只把图片按原样返回；其余一律当纯文本/二进制下载，不在本机域名下渲染仓库里的 HTML
    res.writeHead(200, { 'content-type': type?.startsWith('image/') ? type : 'application/octet-stream', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'cache-control': 'no-store' });
    res.end(b.buf);
    return undefined;
  }
  if (b.tooLarge || b.binary) return { size: b.size, tooLarge: !!b.tooLarge, binary: !!b.binary };
  return { size: b.size, text: b.buf.toString('utf8') };
}

const STATIC = {
  '/vendor/highlight.js': join(here, 'node_modules', '@highlightjs', 'cdn-assets', 'es', 'highlight.min.js'),
};

async function serveStatic(pathname, res) {
  let file = STATIC[pathname];
  const lang = /^\/vendor\/lang\/([a-z0-9-]+)\.js$/.exec(pathname);
  if (lang) file = join(here, 'node_modules', '@highlightjs', 'cdn-assets', 'es', 'languages', `${lang[1]}.min.js`);
  if (!file) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    file = resolve(here, 'web', rel);
    const inside = relative(join(here, 'web'), file);
    if (inside.startsWith('..') || isAbsolute(inside)) return send(res, 404, { error: '没有这个文件' });
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    send(res, 404, { error: '没有这个文件' });
  }
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(json);
}

const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const server = http.createServer(async (req, res) => {
  // 只接本机：挡住 DNS 重绑定和别的网页跨站来调接口
  if (!allowedHosts.has(req.headers.host)) return send(res, 403, { error: 'host 不对' });
  const origin = req.headers.origin;
  if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return send(res, 403, { error: 'origin 不对' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') return send(res, 405, { error: '只读' });
    return serveStatic(url.pathname, res);
  }
  const started = Date.now();
  for (const [method, re, handler] of routes) {
    const m = re.exec(url.pathname);
    if (!m) continue;
    if (req.method !== method) return send(res, 405, { error: '方法不对' });
    try {
      let repo = null;
      if (m[1] !== undefined && re.source.includes('\\/api\\/r\\/')) {
        repo = repos.get(decodeURIComponent(m[1]));
        if (!repo) {
          discover();
          repo = repos.get(decodeURIComponent(m[1]));
        }
        if (!repo) return send(res, 404, { error: '没有这个仓库：' + decodeURIComponent(m[1]) });
      }
      const out = await handler(repo, url.searchParams, m, res);
      if (out !== undefined) send(res, 200, out);
      const ms = Date.now() - started;
      if (ms > 1500) console.log(`  慢请求 ${ms}ms  ${req.method} ${url.pathname}${url.search}`);
    } catch (e) {
      const status = e.status ?? (/(unknown revision|bad revision|not a valid object|does not exist|exists on disk, but not in|no such path|Not a valid object name|invalid object name|fatal: path)/i.test(e.stderr ?? '') ? 404 : 500);
      if (status >= 500) console.warn(`  出错 ${req.method} ${url.pathname}${url.search}：${firstLine(e)}`);
      send(res, status, { error: firstLine(e) });
    }
    return;
  }
  send(res, 404, { error: '没有这个接口' });
});

server.listen(PORT, HOST, () => {
  const link = `http://localhost:${PORT}/`;
  console.log(`BranchMap 已启动：${link}`);
  console.log(`仓库 ${repos.size} 个：${[...repos.keys()].join('，')}`);
  if (process.argv.includes('--open')) {
    const cmd = process.platform === 'win32' ? `start "" "${link}"` : process.platform === 'darwin' ? `open "${link}"` : `xdg-open "${link}"`;
    exec(cmd);
  }
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `端口 ${PORT} 被占用：用 --port=<别的端口> 换一个，或者先关掉已经在跑的 BranchMap` : e.message);
  process.exit(1);
});
