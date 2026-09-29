// BranchMap 本机服务：一个仓库一个项目，页面在 web/ 里。
// 只监听 127.0.0.1。对你的仓库只读不写；联网的只有两件事：
//   1. 同步 BranchMap 自己的云端副本（.cache/mirrors，定时 git fetch）
//   2. 对配置里的环境地址发只读的 HTTP GET，读出线上跑的版本
//
// 用法：node server.mjs [--root=<放仓库的目录>] [--port=4317] [--open]
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, resolve, extname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { loadConfig } from './lib/config.mjs';
import { Workspace } from './lib/project.mjs';
import { firstLine, git, run } from './lib/git.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let cfg;
try {
  cfg = loadConfig(here);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
if (!cfg.scan.length && !cfg.extraRepos.length && !cfg.projects.length) {
  console.error('不知道去哪找仓库：用 --root=<目录> 指定，或者照 config.example.json 写一份 config.json');
  process.exit(1);
}
const PORT = cfg.port;
const HOST = '127.0.0.1';
const ws = new Workspace(cfg);

/* ---------- 路由 ---------- */
const P = (re) => new RegExp('^/api/p/([^/]+)' + re + '$');
const routes = [
  ['GET', /^\/api\/projects$/, async () => ({
    projects: await Promise.all(ws.list().map((p) => p.summary())),
    scan: cfg.scan,
    unmatched: ws.scanner.unmatched.map((r) => r.name),
    configured: cfg.projects.length,
  })],
  // 看板：所有项目要处理的问题、各项目主线与环境、谁在忙、本机没推送的
  ['GET', /^\/api\/board$/, async () => ({
    projects: await Promise.all(ws.list().map((p) => p.board())),
  })],
  // 我：本机 Git 的身份 + GitHub 账号的头像（gh 登录了才有），侧栏底部显示
  ['GET', /^\/api\/me$/, () => me()],
  // 项目化：候选仓库、添加、移除
  ['GET', /^\/api\/discovered$/, () => ws.discovered()],
  ['POST', /^\/api\/projects$/, async (p, q, m, res, req) => {
    const body = await readBody(req);
    const remote = String(body?.remote ?? '').trim();
    if (!remote) throw Object.assign(new Error('填一个仓库地址'), { status: 400 });
    const id = ws.addProject({ remote, name: String(body.name ?? '').trim().slice(0, 40), group: String(body.group ?? '').trim().slice(0, 20) }, here);
    return { ok: true, id };
  }],
  // 项目设置：主线分支（上线分支 + 可选的集成分支）和环境
  ['POST', P('/settings'), async (p, q, m, res, req) => {
    const body = await readBody(req);
    const G = await p.graph();
    let flow;
    if (body.flow !== undefined) {
      flow = Array.isArray(body.flow) ? body.flow.filter(Boolean).map(String) : [];
      if (flow.length > 2 || new Set(flow).size !== flow.length || flow.some((b) => !G.branches.has(b))) throw Object.assign(new Error('主线分支选得不对'), { status: 400 });
    }
    const envs = body.environments;
    if (envs !== undefined) {
      if (!Array.isArray(envs) || envs.some((e) => typeof e?.name !== 'string' || !e.name.trim() || e.name.length > 40)) throw Object.assign(new Error('环境格式不对'), { status: 400 });
      for (const e of envs) {
        if (e.probe && !/^https?:\/\/\S+$/i.test(String(e.probe).trim())) throw Object.assign(new Error('探测地址要以 http:// 或 https:// 开头'), { status: 400 });
      }
    }
    await p.setSettings({ flow, environments: envs }, here);
    return { ok: true };
  }],
  // 分支的自定义标签
  ['POST', P('/branch-tags'), async (p, q, m, res, req) => {
    const body = await readBody(req);
    const branch = String(body?.branch ?? '');
    const tags = Array.isArray(body?.tags) ? [...new Set(body.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 8) : null;
    if (!branch || !tags || tags.some((t) => t.length > 16)) throw Object.assign(new Error('标签格式不对'), { status: 400 });
    p.setBranchTags(branch, tags, here);
    return { ok: true };
  }],
  // 左侧栏拖动排序（顺带改分组）：body = { order: [{ id, group }] }
  ['POST', /^\/api\/projects\/order$/, async (p, q, m, res, req) => {
    const body = await readBody(req);
    if (!Array.isArray(body?.order) || body.order.some((x) => typeof x?.id !== 'string')) throw Object.assign(new Error('顺序格式不对'), { status: 400 });
    ws.reorder(body.order, here);
    return { ok: true };
  }],
  ['POST', P('/remove'), (p) => {
    ws.removeProject(p.id, here);
    return { ok: true };
  }],
  ['GET', P('/overview'), (p) => p.snapshot()],
  ['GET', P('/graph'), (p) => p.graphData()],
  ['GET', P('/worktrees'), (p) => (p.local?.checkouts ?? []).filter((c) => !c.missing)],
  ['GET', P('/wtdiff'), (p, q) => {
    const c = p.checkout(q.get('wt'));
    return ws.scanner.worktreeDiff(c.path, { file: q.get('path'), old: q.get('old'), untracked: q.get('untracked') === '1', ctx: q.get('ctx'), ws: q.get('ws') === '1' });
  }],
  ['GET', P('/commit/([0-9a-f]{7,40})'), (p, q, m) => p.repo.commit(m[2], Number(q.get('parent') ?? 1))],
  ['GET', P('/compare'), async (p, q) => p.repo.compare(await refOf(p, q.get('base')), await refOf(p, q.get('head')))],
  ['GET', P('/diff'), async (p, q) => p.repo.diff({ from: q.get('from') === 'EMPTY' || !q.get('from') ? q.get('from') : await refOf(p, q.get('from')), to: await refOf(p, q.get('to')), path: q.get('path'), old: q.get('old'), ctx: q.get('ctx'), ws: q.get('ws') === '1' })],
  ['GET', P('/blob'), blobRoute],
  ['GET', P('/prs'), (p, q) => p.repo.prs(q.get('refresh') === '1')],
  ['POST', P('/sync'), async (p) => {
    const r = await p.sync();
    await Promise.all([p.probeEnvs(), p.refreshLocal()]);
    return { ok: !r.error, error: r.error ?? null, sync: p.syncState() };
  }],
  // 分支上的环境标签（生产、测试……）：页面上加 / 改 / 删，写回 config.json
  ['POST', P('/labels'), async (p, q, m, res, req) => {
    const body = await readBody(req);
    const list = Array.isArray(body?.environments) ? body.environments : null;
    if (!list || list.some((e) => typeof e?.name !== 'string' || !e.name.trim() || e.name.length > 40)) throw Object.assign(new Error('标签格式不对'), { status: 400 });
    for (const e of list) {
      if (e.probe && !/^https?:\/\/\S+$/i.test(String(e.probe).trim())) throw Object.assign(new Error('探测地址要以 http:// 或 https:// 开头'), { status: 400 });
    }
    await p.setEnvironments(list, here);
    return { ok: true };
  }],
  ['POST', P('/refresh'), async (p) => {
    await Promise.all([p.refreshLocal(), p.probeEnvs()]);
    return { ok: true };
  }],
];

let meCache = null;
async function me() {
  if (meCache && Date.now() - meCache.at < 30 * 60 * 1000) return meCache.value;
  const [name, email, gh] = await Promise.all([
    git(here, ['config', '--global', 'user.name']).then((s) => s.trim()).catch(() => ''),
    git(here, ['config', '--global', 'user.email']).then((s) => s.trim()).catch(() => ''),
    run('gh', ['api', 'user', '--jq', '{login: .login, avatar: .avatar_url, name: .name}'], { timeout: 10000 }).then((s) => JSON.parse(s)).catch(() => null),
  ]);
  const value = { name: name || gh?.name || gh?.login || null, email: email || null, login: gh?.login ?? null, avatar: gh?.avatar ? gh.avatar + (gh.avatar.includes('?') ? '&' : '?') + 's=64' : null };
  meCache = { at: Date.now(), value };
  return value;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(Object.assign(new Error('请求太大'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('不是合法的 JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** 页面上说的分支名（dev）在云端副本里叫 origin/dev。 */
async function refOf(p, ref) {
  if (!ref) throw Object.assign(new Error('缺少引用'), { status: 400 });
  if (/^[0-9a-f]{7,40}$/.test(ref)) return ref;
  const G = await p.graph();
  if (G.branches.has(ref)) return `refs/remotes/origin/${ref}`;
  if (G.tags.has(ref)) return `refs/tags/${ref}`;
  return ref;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.avif': 'image/avif',
};

async function blobRoute(p, q, m, res) {
  const b = await p.repo.blob(await refOf(p, q.get('ref')), q.get('path'));
  if (q.get('raw') === '1') {
    if (b.tooLarge) throw Object.assign(new Error('文件太大'), { status: 413 });
    const type = MIME[extname(q.get('path')).toLowerCase()];
    // 只把图片按原样返回；其余一律当二进制，不在本机域名下渲染仓库里的 HTML
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

/* ---------- 实时推送：任何项目的数据变了，页面马上知道 ---------- */
const clients = new Set();
function events(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 3000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
}
ws.on('change', (e) => {
  const line = `data: ${JSON.stringify(e)}\n\n`;
  for (const c of clients) c.write(line);
});
setInterval(() => {
  for (const c of clients) c.write(': ping\n\n');
}, 25000).unref();

const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const server = http.createServer(async (req, res) => {
  // 只接本机：挡住 DNS 重绑定和别的网页跨站来调接口
  if (!allowedHosts.has(req.headers.host)) return send(res, 403, { error: 'host 不对' });
  const origin = req.headers.origin;
  if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return send(res, 403, { error: 'origin 不对' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/events') return events(req, res);
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') return send(res, 405, { error: '只读' });
    return serveStatic(url.pathname, res);
  }
  const started = Date.now();
  let wrongMethod = false;
  for (const [method, re, handler] of routes) {
    const m = re.exec(url.pathname);
    if (!m) continue;
    if (req.method !== method) {
      wrongMethod = true;
      continue;
    }
    try {
      let project = null;
      if (re.source.startsWith('^\\/api\\/p\\/')) {
        project = ws.get(decodeURIComponent(m[1]));
        if (!project) return send(res, 404, { error: '没有这个项目：' + decodeURIComponent(m[1]) });
      }
      const out = await handler(project, url.searchParams, m, res, req);
      if (out !== undefined) send(res, 200, out);
      const ms = Date.now() - started;
      if (ms > 2000) console.log(`  慢请求 ${ms}ms  ${req.method} ${url.pathname}${url.search}`);
    } catch (e) {
      const status = e.status ?? (/(unknown revision|bad revision|not a valid object|does not exist|exists on disk, but not in|no such path|Not a valid object name|invalid object name|fatal: path)/i.test(e.stderr ?? '') ? 404 : 500);
      if (status >= 500) console.warn(`  出错 ${req.method} ${url.pathname}${url.search}：${firstLine(e)}`);
      send(res, status, { error: firstLine(e) });
    }
    return;
  }
  send(res, wrongMethod ? 405 : 404, { error: wrongMethod ? '方法不对' : '没有这个接口' });
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `端口 ${PORT} 被占用：用 --port=<别的端口> 换一个，或者先关掉已经在跑的 BranchMap` : e.message);
  process.exit(1);
});

await ws.init();
server.listen(PORT, HOST, () => {
  const link = `http://localhost:${PORT}/`;
  console.log(`BranchMap 已启动：${link}`);
  console.log(`项目 ${ws.projects.size} 个：${ws.list().map((p) => p.name).join('，')}`);
  if (ws.scanner.unmatched.length) console.log(`没有远程地址、没算进项目的仓库：${ws.scanner.unmatched.map((r) => r.name).join('，')}`);
  ws.start();
  if (process.argv.includes('--open')) {
    const cmd = process.platform === 'win32' ? `start "" "${link}"` : process.platform === 'darwin' ? `open "${link}"` : `xdg-open "${link}"`;
    exec(cmd);
  }
});
