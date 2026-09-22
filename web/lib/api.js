// 调本机服务的接口；每个仓一个 RepoStore，缓存结果，仓库有变化时整体作废。
import { Model } from './model.js';

export async function request(url, opts = {}) {
  const res = await fetch(url, opts);
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

export const listRepos = () => request('/api/repos');

export class RepoStore {
  constructor(name) {
    this.name = name;
    this.base = `/api/r/${encodeURIComponent(name)}`;
    this.cache = new Map();
    this.model = null;
    this.loadedAt = 0;
    this.listeners = new Set();
    this.prsState = null;
    this.wtState = null;
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
  /** 读提交图；仓库没变化时沿用旧模型。返回 true 表示模型换了。 */
  async loadModel() {
    const raw = await request(this.base + '/graph');
    this.loadedAt = Date.now();
    if (this.model && raw.generatedAt === this.model.raw.generatedAt) return false;
    this.model = new Model(raw);
    this.cache.clear();
    if (this.prsState?.list) this.model.setPrs(this.prsState.list);
    return true;
  }
  /** PR 列表（gh，慢）：拿到后挂到模型上，并通知页面。 */
  loadPrs(refresh = false) {
    if (this.prsPromise && !refresh) return this.prsPromise;
    this.prsPromise = request(this.base + '/prs' + (refresh ? '?refresh=1' : '')).then((r) => {
      this.prsState = r;
      if (r.available) this.model?.setPrs(r.list);
      this.emit('prs');
      return r;
    }, (e) => {
      this.prsState = { available: false, reason: e.message, list: [] };
      this.emit('prs');
      return this.prsState;
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
      this.wtState = null;
      this.wtPromise = null;
      throw e;
    });
    return this.wtPromise;
  }
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(what) {
    for (const fn of this.listeners) fn(what);
  }

  commit(sha, parent = 1) { return this.get(`/commit/${sha}`, parent > 1 ? { parent } : {}); }
  diff(p) { return this.get('/diff', p); }
  wtdiff(p) { return this.get('/wtdiff', p); }
  compare(base, head) { return this.get('/compare', { base, head }); }
  tree(ref) { return this.get('/tree', { ref }); }
  blob(ref, path) { return this.get('/blob', { ref, path }); }
  rawUrl(ref, path) { return `${this.base}/blob?${qs({ ref, path, raw: 1 })}`; }
  history(ref, path) { return this.get('/history', { ref, path }); }
  blame(ref, path) { return this.get('/blame', { ref, path }); }
  stats(ref) { return this.get('/stats', ref ? { ref } : {}); }
  async fetchRemote() {
    return request(this.base + '/fetch', { method: 'POST' });
  }
  /** 本机工作区变了（或刚同步过远程）：重新读。 */
  async refresh() {
    this.cache.clear();
    this.wtPromise = null;
    const changed = await this.loadModel();
    this.loadWorktrees(true).catch(() => {});
    return changed;
  }
}

const stores = new Map();
export function storeFor(name) {
  if (!stores.has(name)) stores.set(name, new RepoStore(name));
  return stores.get(name);
}
