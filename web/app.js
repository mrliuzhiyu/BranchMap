// 外壳与路由：#/ 首页（项目列表）；#/p/<项目>/<页面>?参数 —— 一次只看一个项目。
// 服务端的数据一变（云端有新提交、环境换了版本、本机有改动）就推过来，当前页面就地刷新。
import { $, esc, icon, ago, stamp, picker, toast, closePop, worst } from './lib/util.js';
import { listProjects, storeFor, connectEvents, onServerChange } from './lib/api.js';
import { closeChanges } from './lib/changes.js';
import * as home from './views/home.js';
import * as flow from './views/flow.js';
import * as people from './views/people.js';
import * as local from './views/local.js';
import * as graph from './views/graph.js';
import * as branches from './views/branches.js';

const VIEWS = [
  { id: 'flow', label: '流水线', icon: 'flow', mod: flow },
  { id: 'people', label: '成员', icon: 'people', mod: people },
  { id: 'local', label: '本机', icon: 'desktop', mod: local },
  { id: 'graph', label: '提交图', icon: 'commit', mod: graph, model: true },
  { id: 'branches', label: '分支与对比', icon: 'branch', mod: branches, model: true },
];

let projectList = null;
let mounted = null; // { key, inst, id }
let live = true;

function parse() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  if (parts[0] === 'p' && parts[1]) return { id: decodeURIComponent(parts[1]), view: VIEWS.some((v) => v.id === parts[2]) ? parts[2] : 'flow', params };
  return { id: null, view: 'home', params };
}
export function href(id, view = 'flow', params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
  return `#/p/${encodeURIComponent(id)}/${view}${q ? '?' + q : ''}`;
}
function go(id, view, params) {
  location.hash = href(id, view, params);
}
/** 只改当前页面的参数（不整页重来）。 */
function setParams(patch, { replace = true } = {}) {
  const { id, view, params } = parse();
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === '' || v === false) params.delete(k);
    else params.set(k, String(v));
  }
  const url = href(id, view, Object.fromEntries(params));
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
}

/* ---------- 顶栏 ---------- */
function syncPill(o) {
  const s = o?.sync;
  if (!s) return '';
  let led = 'good';
  let text = '云端';
  if (s.status === 'syncing' || s.status === 'cloning') {
    led = 'busy';
    text = s.status === 'cloning' ? '正在建云端副本…' : '正在同步…';
  } else if (s.status === 'error') {
    led = 'critical';
    text = '同步失败';
  } else if (s.lastOk) text = `云端 · ${ago(Math.floor(s.lastOk / 1000))}同步`;
  else text = '还没同步过';
  const tip = [
    s.lastOk ? `上次成功同步：${stamp(Math.floor(s.lastOk / 1000))}` : '还没有成功同步过',
    s.lastChange ? `上次发现新提交：${stamp(Math.floor(s.lastChange / 1000))}` : '',
    s.error ? `错误：${s.error}` : '',
    '点击立即同步（只更新 BranchMap 自己的云端副本，不动你的仓库）',
  ].filter(Boolean).join('\n');
  return `<button class="syncpill${s.status === 'error' ? ' err' : ''}" data-sync data-tip="${esc(tip)}"><i class="led ${led}"></i>${esc(text.replace('刚刚同步', '刚刚同步'))}</button>`;
}

function renderTop(route, store) {
  const o = store?.overview;
  const tabs = route.id
    ? `<nav class="tabs">${VIEWS.map((v) => `<a href="${href(route.id, v.id)}" ${v.id === route.view ? 'aria-current="page"' : ''}>${icon[v.icon](14)}${v.label}${v.id === 'local' && o?.local?.counts?.unpushedBranches ? `<span class="pill warn" style="height:17px;padding:0 5px;font-size:10.5px" data-tip="本机有没推送的分支">${o.local.counts.unpushedBranches}</span>` : ''}</a>`).join('')}</nav>`
    : '';
  const theme = document.documentElement.dataset.theme;
  const cur = route.id ? projectList?.projects.find((p) => p.id === route.id) : null;
  const name = o?.name ?? cur?.name ?? route.id;
  const lv = o ? worst(countLevels(o.health)) : cur ? worst(cur.health) : 'info';
  $('#top').innerHTML = `
    <a class="logo" href="#/">${icon.logo(20)}BranchMap</a>
    <button class="repo-btn proj-btn" data-proj-pick data-pop-anchor>${route.id ? `<i class="led ${lv}"></i><b class="ell">${esc(name)}</b>` : '<span class="muted">选择项目</span>'}${icon.chevronDown(12)}</button>
    ${tabs}
    <span class="spacer"></span>
    ${live ? '' : `<span class="conn-lost" data-tip="和本机服务的实时连接断了，正在重连；页面上的数据可能不是最新的">${icon.alert(13)}连接中断</span>`}
    ${route.id && o ? syncPill(o) : ''}
    <button class="icon-btn" data-theme-toggle title="切换深色 / 浅色">${theme === 'light' ? icon.moon(15) : icon.sun(15)}</button>`;
}
function countLevels(h = []) {
  return { critical: h.filter((x) => x.level === 'critical').length, warning: h.filter((x) => x.level === 'warning').length };
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-proj-pick],[data-sync],[data-theme-toggle]');
  if (!t || !t.closest('#top')) return;
  const route = parse();
  if (t.dataset.projPick !== undefined) {
    projectList = await listProjects().catch(() => projectList);
    picker(t, {
      items: (projectList?.projects ?? []).map((p) => ({ value: p.id, label: p.name, group: p.group ?? '项目', hint: p.slug ?? '', html: `<i class="led ${p.ready ? worst(p.health) : 'pending'}" style="box-shadow:none"></i><span class="ell">${esc(p.name)}</span>` })),
      placeholder: '搜索项目',
      selected: route.id ? [route.id] : [],
      onPick: (id) => go(id, route.id ? route.view : 'flow'),
    });
  } else if (t.dataset.themeToggle !== undefined) {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('bm-theme', next);
    } catch {
      /* 无痕模式 */
    }
    renderTop(route, route.id ? storeFor(route.id) : null);
    mounted?.inst?.theme?.();
  } else if (t.dataset.sync !== undefined) {
    const store = storeFor(route.id);
    t.disabled = true;
    t.innerHTML = '<i class="led busy"></i>正在同步…';
    const r = await store.sync().catch((err) => ({ ok: false, error: err.message }));
    if (!r.ok) toast('同步失败：' + r.error);
    else toast('已同步');
    await store.changed('sync');
  }
});

/* ---------- 挂载页面 ---------- */
let routeToken = 0;
async function route_() {
  const my = ++routeToken;
  closePop();
  closeChanges();
  const route = parse();
  const key = `${route.id}|${route.view}`;
  if (mounted?.key === key && mounted.inst?.update) {
    mounted.inst.update(route.params);
    return;
  }
  mounted?.inst?.unmount?.();
  mounted = null;
  const el = $('#view');
  if (!route.id) {
    renderTop(route, null);
    el.innerHTML = '';
    document.title = 'BranchMap';
    mounted = { key, inst: home.mount(el, { href, onList: (l) => (projectList = l) }) };
    return;
  }
  const store = storeFor(route.id);
  watchStore(route.id);
  renderTop(route, store);
  const def = VIEWS.find((v) => v.id === route.view);
  if (!store.overview || (def.model && (!store.model || store.modelStale))) {
    el.innerHTML = `<div class="loading"><span class="spin" style="display:inline-grid">${icon.sync(16)}</span>正在读取 ${esc(route.id)}…</div>`;
    try {
      await store.loadOverview();
      if (store.overview.ready && def.model) await store.loadModel();
    } catch (e) {
      if (my !== routeToken) return;
      el.innerHTML = `<div class="error-box"><b>读不了这个项目</b><p class="t2">${esc(e.message)}</p><a class="link" href="#/">回到项目列表</a></div>`;
      return;
    }
    if (my !== routeToken) return;
  }
  renderTop(route, store);
  el.innerHTML = '';
  const o = store.overview;
  if (!o.ready) {
    el.innerHTML = notReady(o);
    mounted = { key, id: route.id, inst: { refresh: () => { if (store.overview?.ready) { mounted = null; route_(); } } } };
    return;
  }
  const ctx = {
    id: route.id,
    store,
    model: store.model,
    get overview() {
      return store.overview;
    },
    params: route.params,
    href: (view, params) => href(route.id, view, params),
    go: (view, params) => go(route.id, view, params),
    setParams,
    reload: async () => {
      await store.loadModel(true).catch((e) => toast('读取失败：' + e.message));
      mounted?.inst?.unmount?.();
      mounted = null;
      route_();
    },
  };
  if (def.model) store.loadWorktrees().catch(() => {});
  mounted = { key, id: route.id, inst: def.mod.mount(el, ctx) };
  document.title = `${o.name} · ${def.label} · BranchMap`;
}

function notReady(o) {
  const s = o.sync ?? {};
  const err = s.status === 'error';
  return `<div class="error-box" style="border-color:var(--line-2);background:var(--surface)">
    <div class="row" style="gap:10px"><span class="${err ? '' : 'spin'}" style="display:inline-grid">${err ? icon.alert(16) : icon.sync(16)}</span><b>${err ? '云端副本建不起来' : '正在准备云端副本…'}</b></div>
    <p class="t2" style="margin:10px 0 0">${err ? esc(s.error ?? '') : 'BranchMap 会在自己的缓存目录里保存一份这个仓库的 Git 记录（本机有这个仓库时直接从本机拷，很快），之后定时从远程同步。你的仓库不会被改动。'}</p>
  </div>`;
}

/* ---------- 实时刷新 ---------- */
// 首页：任何项目变了都重读列表（项目页由各自的 store 处理，见 watchStore）
onServerChange((e) => {
  if (!parse().id) mounted?.inst?.refresh?.(e);
});
// 当前项目的 store 拿到新快照后：顶栏和页面就地更新
function watchStore(id) {
  const store = storeFor(id);
  if (store.watched) return;
  store.watched = true;
  store.on((what, info) => {
    const route = parse();
    if (route.id !== id || what !== 'overview') return;
    renderTop(route, store);
    const def = VIEWS.find((v) => v.id === route.view);
    if (!mounted?.inst) return;
    if (def?.model && info?.what === 'cloud') {
      mounted.inst.stale?.();
      return;
    }
    mounted.inst.refresh?.(info);
  });
}
window.addEventListener('popstate', () => {
  const r = parse();
  if (r.id) watchStore(r.id);
  route_();
});
// 回到这个窗口：让服务端马上重读本机和环境（云端按自己的节奏同步）
let lastFocus = 0;
window.addEventListener('focus', () => {
  const route = parse();
  if (!route.id || Date.now() - lastFocus < 20000) return;
  lastFocus = Date.now();
  storeFor(route.id).refresh().catch(() => {});
});
// 时间（「3 分钟前」）每分钟重画一次顶栏
setInterval(() => {
  const r = parse();
  if (r.id) renderTop(r, storeFor(r.id));
}, 60000);

connectEvents((ok) => {
  if (ok === live) return;
  live = ok;
  const r = parse();
  renderTop(r, r.id ? storeFor(r.id) : null);
  // 重连后补一次：断开期间可能错过了变化
  if (ok && r.id) storeFor(r.id).changed('reconnect');
  if (ok && !r.id) mounted?.inst?.refresh?.({});
});
listProjects().then((l) => (projectList = l)).catch(() => {});
const first = parse();
if (first.id) watchStore(first.id);
route_();
