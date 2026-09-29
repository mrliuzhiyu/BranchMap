// 外壳与路由：左侧浮动导航卡（总览 + 按组列出项目），右侧是内容。
//   #/                    总览（所有项目）
//   #/p/<项目>/<页面>?参数  一个项目一页，项目头下面是顶部标签页
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
  { id: 'flow', label: '流水线', mod: flow },
  { id: 'people', label: '成员', mod: people },
  { id: 'local', label: '本机', mod: local },
  { id: 'graph', label: '提交图', mod: graph, model: true },
  { id: 'branches', label: '分支与对比', mod: branches, model: true },
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

/* ---------- 左侧导航卡 ---------- */
function renderSide(route) {
  const list = projectList?.projects ?? [];
  const groups = new Map();
  for (const p of list) {
    const g = p.group ?? '项目';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  const item = (p) => {
    const lv = !p.ready ? (p.sync?.status === 'error' ? 'critical' : 'busy') : worst(p.health);
    const tip = !p.ready ? (p.sync?.status === 'error' ? '云端副本建不起来' : '正在准备云端副本') : lv === 'critical' ? `${p.health.critical} 个严重问题` : lv === 'warning' ? `${p.health.warning} 个需要注意` : '';
    return `<a class="sb-item" href="${href(p.id, route.id === p.id ? route.view : 'flow')}" ${route.id === p.id ? 'aria-current="page"' : ''}>
      <span class="ic">${icon.branch(14)}</span><span class="nm">${esc(p.name)}</span>
      ${lv === 'critical' || lv === 'warning' || lv === 'busy' ? `<i class="sd ${lv}" data-tip="${esc(tip)}"></i>` : ''}
      ${p.ready && p.inFlight ? `<span class="ct" data-tip="在途工作">${p.inFlight}</span>` : ''}
    </a>`;
  };
  const failed = list.filter((p) => p.sync?.status === 'error').length;
  const theme = document.documentElement.dataset.theme;
  $('#side').innerHTML = `
    <a class="sb-logo" href="#/">${icon.logo(22)}<b>BranchMap</b></a>
    <button class="sb-search" data-search data-pop-anchor>${icon.search(14)}<span>搜索项目</span><kbd>Ctrl K</kbd></button>
    <nav class="sb-nav">
      <p class="sb-label">浏览</p>
      <a class="sb-item" href="#/" ${!route.id ? 'aria-current="page"' : ''}><span class="ic">${icon.home(14)}</span><span class="nm">总览</span>${list.length ? `<span class="ct">${list.length}</span>` : ''}</a>
      ${[...groups].map(([g, ps]) => `<p class="sb-label">${esc(g)}</p>${ps.map(item).join('')}`).join('')}
      ${!projectList ? '<p class="sb-label">正在读取项目…</p>' : ''}
    </nav>
    <div class="sb-foot">
      ${live ? `<i class="led ${failed ? 'critical' : 'good'}"></i><span class="grow" data-tip="${failed ? `${failed} 个项目云端同步失败` : '和本机服务的实时连接正常，数据变了会自动刷新'}">${failed ? `${failed} 个同步失败` : '实时同步中'}</span>` : `<span class="conn-lost grow" data-tip="和本机服务的实时连接断了，正在重连">${icon.alert(12)}连接中断</span>`}
      <button class="icon-btn" data-theme-toggle title="切换深色 / 浅色">${theme === 'dark' ? icon.sun(15) : icon.moon(15)}</button>
    </div>`;
}

/* ---------- 项目头：名字、说明、同步状态、顶部标签页 ---------- */
function syncPill(o) {
  const s = o?.sync;
  if (!s) return '';
  let led = 'good';
  let text;
  if (s.status === 'syncing' || s.status === 'cloning') {
    led = 'busy';
    text = s.status === 'cloning' ? '正在建云端副本…' : '正在同步…';
  } else if (s.status === 'error') {
    led = 'critical';
    text = '同步失败';
  } else text = s.lastOk ? `云端 · ${ago(Math.floor(s.lastOk / 1000))}同步` : '还没同步过';
  const tip = [
    s.lastOk ? `上次成功同步：${stamp(Math.floor(s.lastOk / 1000))}` : '还没有成功同步过',
    s.lastChange ? `上次发现新提交：${stamp(Math.floor(s.lastChange / 1000))}` : '',
    s.error ? `错误：${s.error}` : '',
    '点击立即同步（只更新 BranchMap 自己的云端副本，不动你的仓库）',
  ].filter(Boolean).join('\n');
  return `<button class="syncpill${s.status === 'error' ? ' err' : ''}" data-sync data-tip="${esc(tip)}"><i class="led ${led}"></i>${esc(text)}</button>`;
}

function renderHead(route, store) {
  const el = $('#phead');
  if (!route.id) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  const o = store?.overview;
  const cur = projectList?.projects.find((p) => p.id === route.id);
  const name = o?.name ?? cur?.name ?? route.id;
  const desc = o?.description ?? cur?.description;
  const slug = o?.slug ?? cur?.slug;
  const web = o?.web ?? cur?.web;
  const flowText = o?.stages?.map((s) => s.name).join(' → ');
  const counts = o?.local?.counts;
  const tabCount = (v) => {
    if (v.id === 'people' && o?.people) return `<span class="n">${o.people.filter((p) => !p.bot).length}</span>`;
    if (v.id === 'local' && counts?.unpushedBranches) return `<span class="n warn" data-tip="本机有 ${counts.unpushedBranches} 条分支没推送">${counts.unpushedBranches}</span>`;
    return '';
  };
  el.innerHTML = `<div class="wrap">
    <div class="phead-row">
      <div style="min-width:0">
        <h1>${esc(name)}</h1>
        <div class="desc">${desc ? `<span>${esc(desc)}</span>` : ''}${slug && web ? `${desc ? '<span class="dot">·</span>' : ''}<a href="${esc(web)}" target="_blank" rel="noreferrer">${esc(slug)}${icon.ext(11)}</a>` : ''}${flowText ? `<span class="dot">·</span><span data-tip="流向：代码从左到右一站一站往前走">${esc(flowText)}</span>` : ''}</div>
      </div>
      <div class="acts">${o ? syncPill(o) : ''}</div>
    </div>
    <nav class="ptabs">${VIEWS.map((v) => `<a href="${href(route.id, v.id)}" ${v.id === route.view ? 'aria-current="page"' : ''}>${v.label}${tabCount(v)}</a>`).join('')}</nav>
  </div>`;
}

function renderChrome(route) {
  renderSide(route);
  renderHead(route, route.id ? storeFor(route.id) : null);
}

/* ---------- 交互：搜索、主题、同步 ---------- */
async function openSearch(anchor) {
  const route = parse();
  projectList = await listProjects().catch(() => projectList);
  picker(anchor, {
    items: (projectList?.projects ?? []).map((p) => ({ value: p.id, label: p.name, group: p.group ?? '项目', hint: p.slug ?? '', html: `${icon.branch(13)}<span class="ell">${esc(p.name)}</span>` })),
    placeholder: '搜索项目',
    selected: route.id ? [route.id] : [],
    width: 300,
    onPick: (id) => go(id, route.id ? route.view : 'flow'),
  });
}
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    const b = document.querySelector('[data-search]');
    if (b) openSearch(b);
  }
});
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-search],[data-sync],[data-theme-toggle]');
  if (!t || !(t.closest('#side') || t.closest('#phead'))) return;
  const route = parse();
  if (t.dataset.search !== undefined) openSearch(t);
  else if (t.dataset.themeToggle !== undefined) {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('bm-theme', next);
    } catch {
      /* 无痕模式 */
    }
    renderSide(route);
    mounted?.inst?.theme?.();
  } else if (t.dataset.sync !== undefined) {
    const store = storeFor(route.id);
    t.disabled = true;
    t.innerHTML = '<i class="led busy"></i>正在同步…';
    const r = await store.sync().catch((err) => ({ ok: false, error: err.message }));
    toast(r.ok ? '已同步' : '同步失败：' + r.error);
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
  renderSide(route);
  if (mounted?.key === key && mounted.inst?.update) {
    mounted.inst.update(route.params);
    return;
  }
  mounted?.inst?.unmount?.();
  mounted = null;
  const el = $('#view');
  if (!route.id) {
    renderHead(route, null);
    el.innerHTML = '';
    document.title = 'BranchMap';
    mounted = { key, inst: home.mount(el, { href, onList: (l) => { projectList = l; renderSide(parse()); } }) };
    return;
  }
  const store = storeFor(route.id);
  watchStore(route.id);
  renderHead(route, store);
  const def = VIEWS.find((v) => v.id === route.view);
  if (!store.overview || (def.model && (!store.model || store.modelStale))) {
    el.innerHTML = `<div class="loading"><span class="spin" style="display:inline-grid">${icon.sync(16)}</span>正在读取…</div>`;
    try {
      await store.loadOverview();
      if (store.overview.ready && def.model) await store.loadModel();
    } catch (e) {
      if (my !== routeToken) return;
      el.innerHTML = `<div class="error-box"><b>读不了这个项目</b><p class="t2">${esc(e.message)}</p><a class="link" href="#/">回到总览</a></div>`;
      return;
    }
    if (my !== routeToken) return;
  }
  renderHead(route, store);
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
  return `<div class="error-box" style="border-color:var(--line);background:var(--surface)">
    <div class="row" style="gap:10px"><span class="${err ? '' : 'spin'}" style="display:inline-grid">${err ? icon.alert(16) : icon.sync(16)}</span><b>${err ? '云端副本建不起来' : '正在准备云端副本…'}</b></div>
    <p class="t2" style="margin:10px 0 0">${err ? esc(s.error ?? '') : 'BranchMap 会在自己的缓存目录里保存一份这个仓库的 Git 记录（本机有这个仓库时直接从本机拷，很快），之后定时从远程同步。你的仓库不会被改动。'}</p>
  </div>`;
}

/* ---------- 实时刷新 ---------- */
// 项目列表（左侧导航的状态点、在途数）：任何项目变了就稍后重读
let listTimer = null;
onServerChange((e) => {
  clearTimeout(listTimer);
  listTimer = setTimeout(async () => {
    projectList = await listProjects().catch(() => projectList);
    renderSide(parse());
  }, 1500);
  if (!parse().id) mounted?.inst?.refresh?.(e);
});
// 当前项目拿到新快照：项目头和页面就地更新
function watchStore(id) {
  const store = storeFor(id);
  if (store.watched) return;
  store.watched = true;
  store.on((what, info) => {
    const route = parse();
    if (route.id !== id || what !== 'overview') return;
    renderHead(route, store);
    const def = VIEWS.find((v) => v.id === route.view);
    if (!mounted?.inst) return;
    if (def?.model && info?.what === 'cloud') {
      mounted.inst.stale?.();
      return;
    }
    mounted.inst.refresh?.(info);
  });
}
window.addEventListener('popstate', route_);
// 回到这个窗口：让服务端马上重读本机和环境（云端按自己的节奏同步）
let lastFocus = 0;
window.addEventListener('focus', () => {
  const route = parse();
  if (!route.id || Date.now() - lastFocus < 20000) return;
  lastFocus = Date.now();
  storeFor(route.id).refresh().catch(() => {});
});
// 时间（「3 分钟前」）每分钟重画一次
setInterval(() => renderChrome(parse()), 60000);

connectEvents((ok) => {
  if (ok === live) return;
  live = ok;
  const r = parse();
  renderSide(r);
  // 重连后补一次：断开期间可能错过了变化
  if (ok && r.id) storeFor(r.id).changed('reconnect');
  if (ok && !r.id) mounted?.inst?.refresh?.({});
});
listProjects().then((l) => {
  projectList = l;
  renderChrome(parse());
}).catch(() => {});
route_();
