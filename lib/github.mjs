// 连接 GitHub：用 GitHub App 授权读仓库。
//   1. 管理员在页面上点「连接 GitHub」→ 跳到 GitHub 的「创建应用」页（App Manifest：权限、回调、Webhook 都预先填好）
//      → 创建后 GitHub 带着一次性 code 回来，这里换出 App ID、私钥、Webhook 密钥，存进缓存目录（只有服务自己能读）
//   2. 跳到「安装」页：选组织、勾仓库 → 回来以后「添加项目」里就列出这些仓库
//   3. 之后 PR / CI / 头像走 api.github.com（安装令牌，1 小时过期、只读、只限勾选的仓库）；有人推送时 GitHub 发 Webhook 过来
// 没连 App 时（本机用法）退回本机 gh 的登录（gh auth token），和以前一样。
// App 申请的权限全是只读：BranchMap 只看不改。
import { createSign, createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { run, firstLine } from './git.mjs';

const API = 'https://api.github.com';
const REPOS_EVERY = 10 * 60 * 1000;
const STATE_MS = 30 * 60 * 1000; // 创建应用要在 GitHub 上填表，给足时间

// App 要的权限（全部只读）和要收的事件
const PERMISSIONS = { contents: 'read', metadata: 'read', pull_requests: 'read', checks: 'read', statuses: 'read', members: 'read' };
const EVENTS = ['push', 'pull_request', 'pull_request_review', 'check_suite', 'check_run', 'status'];

export class GitHub {
  constructor(dir) {
    this.dir = dir;
    this.file = join(dir, 'github-app.json');
    this.app = null;
    try {
      this.app = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch { /* 还没连 */ }
    this.tokens = new Map(); // 安装 id → { token, exp }
    this.repos = { at: 0, list: [], bySlug: new Map(), installations: [] };
    this.loading = null;
    this.states = new Map(); // 创建应用的一次性 state
    this.ghToken = null; // 本机 gh 的令牌 { token, at }
  }

  get connected() {
    return !!this.app?.id;
  }

  /* ---------------- 1. 创建应用（App Manifest） ---------------- */

  /**
   * 返回一个自动提交的表单页：把 manifest POST 给 GitHub 的「创建应用」页。
   * org 不空时建在组织名下（推荐：私有 App 只能装到建它的那个账号上）。
   */
  createPage(origin, org, { webhooks = true } = {}) {
    for (const [k, v] of this.states) if (v.exp < Date.now()) this.states.delete(k);
    const state = randomBytes(24).toString('base64url');
    this.states.set(state, { exp: Date.now() + STATE_MS });
    const host = new URL(origin).host;
    const manifest = {
      name: `BranchMap ${host}`.slice(0, 34),
      url: origin,
      description: 'BranchMap：只读的 Git 可视化（提交图、分支、环境、成员）',
      public: false,
      redirect_url: `${origin}/github/created`,
      setup_url: `${origin}/github/installed`,
      setup_on_update: true,
      hook_attributes: { url: `${origin}/api/github/webhook`, active: webhooks },
      default_permissions: PERMISSIONS,
      default_events: webhooks ? EVENTS : [],
    };
    const action = org
      ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${state}`
      : `https://github.com/settings/apps/new?state=${state}`;
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    return `<!doctype html><meta charset="utf-8"><title>正在跳到 GitHub…</title>
<form method="post" action="${esc(action)}"><input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}"><noscript><button>继续到 GitHub</button></noscript></form>
<script>document.forms[0].submit()</script>`;
  }

  /** GitHub 带着 code 回来：换出应用的凭据，存下来。 */
  async finishCreate(code, state) {
    const st = state ? this.states.get(state) : null;
    if (state) this.states.delete(state);
    if (!st || st.exp < Date.now()) throw Object.assign(new Error('这次连接已过期，重新点一次「连接 GitHub」'), { status: 400 });
    if (!/^[\w-]{4,100}$/.test(String(code ?? ''))) throw Object.assign(new Error('GitHub 没有带回 code'), { status: 400 });
    const r = await this.request(`/app-manifests/${code}/conversions`, { method: 'POST' });
    const app = {
      id: r.id,
      slug: r.slug,
      name: r.name,
      url: r.html_url,
      owner: r.owner?.login ?? null,
      ownerType: r.owner?.type ?? null,
      clientId: r.client_id,
      clientSecret: r.client_secret,
      webhookSecret: r.webhook_secret ?? null,
      pem: r.pem,
      createdAt: new Date().toISOString(),
    };
    if (!app.id || !app.pem) throw new Error('GitHub 没有返回应用凭据');
    mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(app, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.app = app;
    this.tokens.clear();
    this.repos.at = 0;
    console.log(`  已连接 GitHub App：${app.name}（${app.owner}）`);
    return app;
  }

  /** 去 GitHub 选组织、勾仓库（第一次安装或之后增减仓库都走这里）。 */
  installUrl() {
    return this.app ? `${this.app.url}/installations/new` : null;
  }

  /* ---------------- 2. 令牌 ---------------- */

  /** App 自己的身份（RS256 JWT，10 分钟）：只用来换安装令牌、列安装。 */
  appJwt() {
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const body = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: String(this.app.id) })}`;
    return `${body}.${createSign('RSA-SHA256').update(body).sign(this.app.pem, 'base64url')}`;
  }

  async installationToken(id) {
    const hit = this.tokens.get(id);
    if (hit && hit.exp - Date.now() > 5 * 60 * 1000) return hit.token;
    const r = await this.request(`/app/installations/${id}/access_tokens`, { method: 'POST', token: this.appJwt(), bearer: true });
    this.tokens.set(id, { token: r.token, exp: Date.parse(r.expires_at) });
    return r.token;
  }

  /** 所有安装 → 每个安装能读的仓库。十分钟刷新一次；Webhook 说仓库有变动时立刻刷新。 */
  async loadRepos(force = false) {
    if (!this.connected) return this.repos;
    if (!force && Date.now() - this.repos.at < REPOS_EVERY) return this.repos;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const installs = await this.request('/app/installations?per_page=100', { token: this.appJwt(), bearer: true });
      const list = [];
      const bySlug = new Map();
      const installations = [];
      for (const ins of installs) {
        const token = await this.installationToken(ins.id);
        let n = 0;
        for (let page = 1; page <= 20; page++) {
          const r = await this.request(`/installation/repositories?per_page=100&page=${page}`, { token });
          for (const repo of r.repositories ?? []) {
            const slug = repo.full_name.toLowerCase();
            bySlug.set(slug, ins.id);
            list.push({ slug: repo.full_name, private: repo.private, description: repo.description ?? '', url: repo.html_url, remote: repo.clone_url, pushedAt: repo.pushed_at ? Date.parse(repo.pushed_at) / 1000 : null, owner: ins.account?.login ?? null });
            n++;
          }
          if ((r.repositories ?? []).length < 100) break;
        }
        installations.push({ id: ins.id, account: ins.account?.login ?? '?', type: ins.account?.type ?? null, avatar: ins.account?.avatar_url ?? null, repos: n, all: ins.repository_selection === 'all', manage: ins.html_url ?? null });
      }
      list.sort((a, b) => (b.pushedAt ?? 0) - (a.pushedAt ?? 0));
      this.repos = { at: Date.now(), list, bySlug, installations };
      return this.repos;
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /**
   * 读这个仓库用的令牌：连了 App 就用它装到这个仓库上的安装令牌；
   * 没连 App 时用本机 gh 的登录。都没有返回 null。
   */
  async tokenFor(slug) {
    if (this.connected) {
      const { bySlug } = await this.loadRepos().catch(() => this.repos);
      let id = bySlug.get(String(slug).toLowerCase());
      // 刚装上 / 刚勾选的仓库：强制刷一次再找
      if (!id && Date.now() - this.repos.at > 30000) id = (await this.loadRepos(true).catch(() => this.repos)).bySlug.get(String(slug).toLowerCase());
      return id ? this.installationToken(id) : null;
    }
    // 本机 gh：从系统钥匙串取令牌，有的电脑上要几十秒——拿到就缓存，多个项目同时要也只跑一次
    const hit = this.ghToken;
    if (hit && Date.now() - hit.at < (hit.token ? 6 * 3600e3 : 5 * 60e3)) return hit.token;
    this.ghLoading ??= run('gh', ['auth', 'token'], { timeout: 90000 }).then((s) => s.trim(), () => '').then((token) => {
      this.ghToken = { token: token || null, at: Date.now() };
      this.ghLoading = null;
      return this.ghToken.token;
    });
    return this.ghLoading;
  }

  /** 读不到这个仓库时给人看的原因。 */
  missingReason() {
    return this.connected ? 'GitHub App 没装到这个仓库：在「添加项目」里点「管理授权」把它勾上' : '没有连接 GitHub：在「添加项目」里点「连接 GitHub」，或者本机 gh auth login';
  }

  /** git 联网时带上安装令牌（放在环境变量里，不进命令行参数）；没连 App 返回 null，用本机的 Git 登录。 */
  async gitEnv(slug) {
    if (!this.connected || !slug) return null;
    const token = await this.tokenFor(slug).catch(() => null);
    if (!token) return null;
    return {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from('x-access-token:' + token).toString('base64')}`,
    };
  }

  /* ---------------- 3. 调接口 ---------------- */

  /** api.github.com 的 REST 请求。网络抖动重试一次；4xx / 5xx 抛出带 status 的错误。 */
  async request(path, { method = 'GET', token = null, bearer = false, body = null } = {}) {
    const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'BranchMap' };
    if (token) headers.authorization = `${bearer ? 'Bearer' : 'token'} ${token}`;
    if (body) headers['content-type'] = 'application/json';
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
      } catch (e) {
        if (attempt < 1) continue;
        throw new Error('连不上 api.github.com：' + (e.cause?.code ?? e.message));
      }
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch { /* 不是 JSON */ }
      if (res.ok) return data;
      // 本机 gh 的令牌失效了（重新登录过 / 被撤销）：下次重取
      if (res.status === 401 && token && token === this.ghToken?.token) this.ghToken = null;
      if (res.status >= 500 && attempt < 1) continue;
      throw Object.assign(new Error(`GitHub ${res.status}：${data?.message ?? text.slice(0, 200)}`), { status: res.status });
    }
  }

  /** GraphQL：部分结果出错时（比如个别提交没推上去）照样返回 data。 */
  async graphql(token, query, variables = {}) {
    const r = await this.request('/graphql', { method: 'POST', token, bearer: true, body: { query, variables } });
    if (!r?.data && r?.errors?.length) throw new Error('GitHub GraphQL：' + r.errors[0].message);
    return r?.data ?? {};
  }

  /* ---------------- 4. Webhook ---------------- */

  /** X-Hub-Signature-256 = sha256=HMAC(webhookSecret, 原始请求体)。 */
  verify(raw, signature) {
    if (!this.app?.webhookSecret || !signature) return false;
    const want = Buffer.from('sha256=' + createHmac('sha256', this.app.webhookSecret).update(raw).digest('hex'));
    const got = Buffer.from(String(signature));
    return got.length === want.length && timingSafeEqual(got, want);
  }

  /** 页面上看的状态（不含任何密钥）。 */
  async status() {
    if (!this.connected) return { connected: false };
    let error = null;
    const r = await this.loadRepos().catch((e) => {
      error = firstLine(e);
      return this.repos;
    });
    return {
      connected: true,
      app: { name: this.app.name, slug: this.app.slug, url: this.app.url, owner: this.app.owner, webhooks: !!this.app.webhookSecret },
      installUrl: this.installUrl(),
      installations: r.installations,
      repos: r.list,
      error,
    };
  }
}
