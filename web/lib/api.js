// 调本机服务的接口。每个项目一个 ProjectStore：
//   overview —— 流水线、在途、成员、健康、本机（服务端算好的快照）
//   model    —— 完整提交图（提交图 / 分支页才加载）
// 服务端的数据一变就通过 /api/events 推过来，页面自动刷新。
import { Model } from './model.js';
import { colorPersons } from './flowui.js';

export async function request(url, opts = {}) {
  const res = await fetch(url, opts);
  // 部署在服务器上、飞书登录过期了：重新登录（本机不开门禁，不会有 401）
  if (res.status === 401) {
    location.href = '/auth/login';
    return new Promise(() => {});
  }
  let body;
  try {
    body = await res.json();
  } catch {
    body = { error: `${res.status} ${res.statusText}` };
  }
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
  return body;
}
const qs = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '' && v !== false).map(([k, v]) => [k, v === true ? '1' : String(v)])).toString();

export const listProjects = () => request('/api/projects');

export class ProjectStore {
  constructor(id) {
    this.id = id;
    this.base = `/api/p/${encodeURIComponent(id)}`;
    this.cache = new Map();
    this.overview = null;
    this.model = null;
    this.modelStale = false;
    this.listeners = new Set();
    this.wtState = null;
    this.loading = null;
  }
  get(path, params = {}) {
    const url = this.base + path + (Object.keys(params).length ? '?' + qs(params) : '');
    if (!this.cache.has(url)) {
      const p = request(url);
      this.cache.set(url, p);
      p.catch(() => this.cache.delete(url));
    }
    return this.cache.get(url);
  }

  async loadOverview() {
    if (this.loading) return this.loading;
    this.loading = request(this.base + '/overview').then((o) => {
      if (o.persons) colorPersons(o.persons);
      this.overview = o;
      return o;
    }).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /** 完整提交图（提交图、分支页用）。云端变了就标记过期，下次进这些页面时重读。 */
  async loadModel(force = false) {
    if (this.model && !this.modelStale && !force) return this.model;
    const raw = await request(this.base + '/graph');
    this.model = new Model(raw);
    this.modelStale = false;
    this.cache.clear();
    const prs = this.prsState;
    if (prs?.available) this.model.setPrs(prs.list);
    else this.loadPrs();
    return this.model;
  }
  loadPrs() {
    if (this.prsPromise) return this.prsPromise;
    this.prsPromise = request(this.base + '/prs').then((r) => {
      this.prsState = r;
      if (r.available) this.model?.setPrs(r.list);
      this.emit('prs');
      return r;
    }, () => null).finally(() => {
      setTimeout(() => (this.prsPromise = null), 60000);
    });
    return this.prsPromise;
  }
  loadWorktrees(refresh = false) {
    if (this.wtPromise && !refresh) return this.wtPromise;
    this.wtPromise = request(this.base + '/worktrees').then((r) => {
      this.wtState = r;
      this.emit('worktrees');
      return r;
    }, (e) => {
      this.wtPromise = null;
      throw e;
    });
    return this.wtPromise;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(what, extra) {
    for (const fn of this.listeners) fn(what, extra);
  }

  /** 服务端说数据变了。 */
  async changed(what) {
    if (what === 'cloud') {
      this.modelStale = true;
      this.cache.clear();
    }
    if (what === 'local') this.wtPromise = null;
    const before = this.overview;
    await this.loadOverview().catch(() => null);
    this.emit('overview', { what, before });
  }

  commit(sha, parent = 1) { return this.get(`/commit/${sha}`, parent > 1 ? { parent } : {}); }
  diff(p) { return this.get('/diff', p); }
  wtdiff(p) { return this.get('/wtdiff', p); }
  compare(base, head) { return this.get('/compare', { base, head }); }
  rawUrl(ref, path) { return `${this.base}/blob?${qs({ ref, path, raw: 1 })}`; }
  sync() { return request(this.base + '/sync', { method: 'POST' }); }
  refresh() { return request(this.base + '/refresh', { method: 'POST' }); }
}

const stores = new Map();
export function storeFor(id) {
  if (!stores.has(id)) stores.set(id, new ProjectStore(id));
  return stores.get(id);
}

/* ---------- 实时推送 ---------- */
const globalListeners = new Set();
export function onServerChange(fn) {
  globalListeners.add(fn);
  return () => globalListeners.delete(fn);
}
let es = null;
export function connectEvents(onStatus) {
  if (es) return;
  es = new EventSource('/api/events');
  es.onopen = () => onStatus?.(true);
  es.onerror = () => {
    onStatus?.(false);
    // 浏览器一般会自己重连；连接被判定为关闭（不再重试）时，自己隔几秒重建
    if (es.readyState === EventSource.CLOSED) {
      es = null;
      setTimeout(() => connectEvents(onStatus), 3000);
    }
  };
  es.onmessage = (m) => {
    let e;
    try {
      e = JSON.parse(m.data);
    } catch {
      return;
    }
    if (e.id && stores.has(e.id)) stores.get(e.id).changed(e.what);
    for (const fn of globalListeners) fn(e);
  };
}
