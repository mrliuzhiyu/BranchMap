// 公司飞书门禁：部署到服务器时打开（config.json 里写 auth），本机用不开。
// 做法照官网的员工门禁：飞书企业自建应用 OAuth 登录，只认本企业（tenant_key 对得上）；
// 登录后签一个 12 小时的 Host-only Cookie（HS256 JWT），之后每个请求验它。
// 两个机密只从环境变量读，不进配置文件：
//   BRANCHMAP_FEISHU_APP_SECRET  飞书应用的 App Secret
//   BRANCHMAP_SESSION_SECRET     签 Cookie 的密钥（至少 32 个字符）
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
const TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
const USER_INFO_URL = 'https://open.feishu.cn/open-apis/authen/v1/user_info';
const SESSION_SEC = 12 * 3600;
const STATE_MS = 10 * 60 * 1000; // 扫码通常十几秒，10 分钟足够
const AUD = 'branchmap';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** 读 config.json 里的 auth 段；没写就是不开门禁（返回 null）。缺东西直接报错，不带病启动。 */
export function authConfig(file, env = process.env) {
  const a = file?.auth;
  if (!a) return null;
  const origin = String(a.origin ?? '').replace(/\/+$/, '');
  const problems = [];
  if (!/^https:\/\/[^/]+$/.test(origin)) problems.push('auth.origin 要写成 https://<域名>（飞书只接受 HTTPS 回调）');
  if (!a.feishuAppId) problems.push('auth.feishuAppId 没写');
  if (!env.BRANCHMAP_FEISHU_APP_SECRET) problems.push('环境变量 BRANCHMAP_FEISHU_APP_SECRET 没设');
  if (String(env.BRANCHMAP_SESSION_SECRET ?? '').length < 32) problems.push('环境变量 BRANCHMAP_SESSION_SECRET 没设或不到 32 个字符');
  if (problems.length) throw new Error('飞书门禁配置不全：\n  ' + problems.join('\n  '));
  return {
    origin,
    host: new URL(origin).host,
    appId: String(a.feishuAppId),
    appSecret: env.BRANCHMAP_FEISHU_APP_SECRET,
    secret: env.BRANCHMAP_SESSION_SECRET,
    // 本企业的 tenant_key：没写时第一次登录会在日志里打出来，照着填上
    tenantKey: a.tenantKey ? String(a.tenantKey) : null,
    // 能改配置的人（飞书 open_id 或飞书名字）；不写就谁都不能改
    admins: new Set([a.admins ?? []].flat().map(String)),
  };
}

export function createAuth(A) {
  const cookieName = '__Host-branchmap';
  const redirectUri = A.origin + '/auth/callback';
  const states = new Map(); // state → { to, exp }：一次性，防登录 CSRF

  const sign = (payload) => {
    const body = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify(payload))}`;
    return `${body}.${b64u(createHmac('sha256', A.secret).update(body).digest())}`;
  };
  const verify = (token) => {
    const [h, p, s] = String(token ?? '').split('.');
    if (!h || !p || !s) return null;
    const want = createHmac('sha256', A.secret).update(`${h}.${p}`).digest();
    const got = Buffer.from(s, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    try {
      const v = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
      if (v.aud !== AUD || !v.sub || !v.tk || !(v.exp > Date.now() / 1000)) return null;
      if (A.tenantKey && v.tk !== A.tenantKey) return null;
      return v;
    } catch {
      return null;
    }
  };
  const cookieOf = (req) => {
    for (const part of String(req.headers.cookie ?? '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === cookieName) return part.slice(i + 1).trim();
    }
    return null;
  };
  const setCookie = (res, value, maxAge) => res.setHeader('set-cookie', `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
  // 回跳只接受本站路径，挡住开放重定向
  const safeTo = (to) => (typeof to === 'string' && /^\/(?![/\\])/.test(to) && !to.startsWith('/auth/') ? to : '/');

  const page = (res, status, title, text, link = '/auth/login') => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BranchMap</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:14px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f7f7f7;color:#111}main{max-width:360px;padding:24px;text-align:center}h1{font-size:18px;margin:0 0 8px}p{color:#666;margin:0 0 20px;white-space:pre-line}a{display:inline-block;padding:9px 18px;border-radius:9px;background:#111;color:#fff;text-decoration:none}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}p{color:#999}a{background:#eee;color:#111}}</style>
<main><h1>${esc(title)}</h1>${text ? `<p>${esc(text)}</p>` : ""}<a href="${esc(link)}">用飞书登录</a></main>`);
  };

  async function feishu(url, init) {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
    let body;
    try {
      body = await r.json();
    } catch {
      body = {};
    }
    // v2 token 接口失败走 HTTP 4xx；v1 user_info 失败也是 200，看 body.code
    if (!r.ok || (body.code != null && body.code !== 0)) throw new Error(`飞书返回 ${r.status} code=${body.code ?? ''} ${body.error_description ?? body.msg ?? body.error ?? ''}`.trim());
    return body;
  }

  async function login(url, res) {
    const now = Date.now();
    for (const [k, v] of states) if (v.exp < now) states.delete(k);
    if (states.size > 5000) return page(res, 429, '登录繁忙', '');
    const state = randomBytes(24).toString('base64url');
    states.set(state, { to: safeTo(url.searchParams.get('to')), exp: now + STATE_MS });
    const q = new URLSearchParams({ client_id: A.appId, redirect_uri: redirectUri, response_type: 'code', state });
    res.writeHead(302, { location: `${AUTHORIZE_URL}?${q}`, 'cache-control': 'no-store' });
    res.end();
  }

  async function callback(url, res) {
    const state = url.searchParams.get('state');
    const st = state ? states.get(state) : null;
    if (state) states.delete(state);
    if (!st || st.exp < Date.now()) return page(res, 400, '登录已过期', '');
    const code = url.searchParams.get('code');
    if (!code) return page(res, 403, '授权已取消', '');
    let info;
    try {
      const tok = await feishu(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ grant_type: 'authorization_code', client_id: A.appId, client_secret: A.appSecret, code, redirect_uri: redirectUri }) });
      if (!tok.access_token) throw new Error('飞书没有返回 access_token');
      info = (await feishu(USER_INFO_URL, { headers: { authorization: `Bearer ${tok.access_token}` } })).data ?? {};
    } catch (e) {
      console.warn(`  飞书登录失败：${e.message}`);
      return page(res, 502, '登录失败', '');
    }
    if (!info.open_id || !info.tenant_key) return page(res, 403, '无权访问', '仅限公司成员');
    if (!A.tenantKey) {
      console.warn(`  门禁还没配 tenantKey。${info.name ?? info.open_id} 的企业 tenant_key=${info.tenant_key}，确认是本公司后写进 config.json 的 auth.tenantKey`);
      return page(res, 403, '门禁未配置完成', '');
    }
    if (info.tenant_key !== A.tenantKey) return page(res, 403, '无权访问', '仅限公司成员');
    const exp = Math.floor(Date.now() / 1000) + SESSION_SEC;
    setCookie(res, sign({ aud: AUD, sub: info.open_id, tk: info.tenant_key, name: String(info.name ?? '').slice(0, 64), av: String(info.avatar_url ?? '').slice(0, 512), exp }), SESSION_SEC);
    console.log(`  登录：${info.name ?? info.open_id}`);
    res.writeHead(302, { location: st.to, 'cache-control': 'no-store' });
    res.end();
  }

  return {
    host: A.host,
    /** 当前登录的人（没登录 = null）。 */
    user(req) {
      const v = verify(cookieOf(req));
      return v ? { id: v.sub, name: v.name, avatar: v.av || null } : null;
    },
    /** 能不能改配置（添加 / 移除项目、项目设置、测试探测地址……）。 */
    isAdmin(u) {
      return !!u && (A.admins.has(u.id) || (!!u.name && A.admins.has(u.name)));
    },
    /**
     * 门禁：/auth/* 自己处理；其余请求没登录时，接口回 401，页面跳去登录。
     * 返回 true 表示这个请求已经回复了，调用方不用再管。
     */
    async gate(req, res, url) {
      if (url.pathname === '/auth/login') return login(url, res).then(() => true);
      if (url.pathname === '/auth/callback') return callback(url, res).then(() => true);
      if (url.pathname === '/auth/logout') {
        setCookie(res, '', 0);
        page(res, 200, '已退出', '');
        return true;
      }
      if (this.user(req)) return false;
      if (url.pathname.startsWith('/api/')) {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: '需要登录', login: '/auth/login' }));
      } else {
        res.writeHead(302, { location: '/auth/login?to=' + encodeURIComponent(url.pathname === '/' ? '/' : url.pathname + url.search), 'cache-control': 'no-store' });
        res.end();
      }
      return true;
    },
  };
}
