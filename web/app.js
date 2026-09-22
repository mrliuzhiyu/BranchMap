// 外壳与路由：#/ 首页（只列仓库）；#/r/<仓库>/<页面>?参数 —— 一次只看一个仓库。
import { $, esc, icon, ago, stamp, picker, toast, closePop } from './lib/util.js';
import { listRepos, storeFor } from './lib/api.js';
import { closeChanges } from './lib/changes.js';
import * as home from './views/home.js';
import * as overview from './views/overview.js';
import * as graph from './views/graph.js';
import * as branches from './views/branches.js';
import * as files from './views/files.js';
import * as stats from './views/stats.js';
import * as people from './views/people.js';

const VIEWS = [
  { id: 'overview', label: '概览', icon: 'home', mod: overview },
  { id: 'graph', label: '提交图', icon: 'commit', mod: graph },
  { id: 'branches', label: '分支', icon: 'branch', mod: branches },
  { id: 'files', label: '文件', icon: 'file', mod: files },
  { id: 'stats', label: '统计', icon: 'graph', mod: stats },
  { id: 'people', label: '成员', icon: 'people', mod: people },
];

let repoList = null;
let mounted = null; // { key, repo, view, inst }

function parse() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  if (parts[0] === 'r' && parts[1]) return { repo: decodeURIComponent(parts[1]), view: VIEWS.some((v) => v.id === parts[2]) ? parts[2] : 'overview', params };
  return { repo: null, view: 'home', params };
}
export function href(repo, view = 'overview', params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
  return `#/r/${encodeURIComponent(repo)}/${view}${q ? '?' + q : ''}`;
}
function go(repo, view, params) {
  location.hash = href(repo, view, params);
}
/** 只改当前页面的参数（不整页重来）。 */
function setParams(patch, { replace = true } = {}) {
  const { repo, view, params } = parse();
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === '' || v === false) params.delete(k);
    else params.set(k, String(v));
  }
  const url = href(repo, view, Object.fromEntries(params));
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
}

/* ---------- 顶栏 ---------- */
function renderTop(route, store) {
  const m = store?.model;
  const tabs = route.repo
    ? `<nav class="tabs">${VIEWS.map((v) => `<a href="${href(route.repo, v.id)}" ${v.id === route.view ? 'aria-current="page"' : ''}>${icon[v.icon](14)}${v.label}</a>`).join('')}</nav>`
    : '';
  const theme = document.documentElement.dataset.theme;
  $('#top').innerHTML = `
    <a class="logo" href="#/">${icon.logo(20)}BranchMap</a>
    <button class="repo-btn" data-repo-pick data-pop-anchor>${route.repo ? `${icon.folder(13)}<b class="ell">${esc(route.repo)}</b>` : '<span class="muted">选择仓库</span>'}${icon.chevronDown(12)}</button>
    ${tabs}
    <span class="spacer"></span>
    ${route.repo && m ? `<div class="sync">
        <span title="上次从远程拉取（git fetch）的时间">远程同步于 ${m.raw.fetchedAt ? ago(m.raw.fetchedAt) : '从未'}</span>
        <button class="btn sm" data-fetch title="git fetch --all --prune：只更新远程分支，不动本地分支和工作区">${icon.cloud(13)}同步远程</button>
        <button class="icon-btn" data-reload title="重新读取本机仓库状态（${stamp(m.raw.generatedAt)}）">${icon.sync(14)}</button>
      </div>` : ''}
    <button class="icon-btn" data-theme-toggle title="切换深色 / 浅色">${theme === 'light' ? icon.moon(15) : icon.sun(15)}</button>`;
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-repo-pick],[data-fetch],[data-reload],[data-theme-toggle]');
  if (!t || !t.closest('#top')) return;
  const route = parse();
  if (t.dataset.repoPick !== undefined) {
    repoList ??= await listRepos().catch(() => []);
    picker(t, {
      items: repoList.map((r) => ({ value: r.name, label: r.name, hint: r.head ?? '', html: `${icon.folder(13)}<span class="ell">${esc(r.name)}</span>` })),
      placeholder: '搜索仓库',
      selected: route.repo ? [route.repo] : [],
      onPick: (name) => go(name, route.repo ? route.view : 'overview'),
    });
  } else if (t.dataset.themeToggle !== undefined) {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('bm-theme', next); } catch { /* 无痕模式 */ }
    renderTop(route, route.repo ? storeFor(route.repo) : null);
    mounted?.inst?.theme?.();
  } else if (t.dataset.fetch !== undefined) {
    const store = storeFor(route.repo);
    t.disabled = true;
    t.innerHTML = `<span class="spin" style="display:inline-grid">${icon.sync(13)}</span>同步中…`;
    const r = await store.fetchRemote().catch((err) => ({ ok: false, error: err.message }));
    if (!r.ok) toast('同步失败：' + r.error);
    store.prsPromise = null;
    await reload(true);
    if (r.ok) toast('已同步远程');
  } else if (t.dataset.reload !== undefined) {
    await reload(true);
  }
});

/* ---------- 挂载页面 ---------- */
async function reload(force) {
  const route = parse();
  if (!route.repo) return;
  const store = storeFor(route.repo);
  const changed = await store.refresh().catch((e) => { toast('读取失败：' + e.message); return false; });
  if (changed || force) {
    store.loadPrs();
    mounted?.inst?.unmount?.();
    mounted = null;
    await route_();
  }
}

let routeToken = 0;
async function route_() {
  const my = ++routeToken;
  closePop();
  closeChanges();
  const route = parse();
  const key = `${route.repo}|${route.view}`;
  if (mounted?.key === key && mounted.inst?.update) {
    mounted.inst.update(route.params);
    return;
  }
  mounted?.inst?.unmount?.();
  mounted = null;
  const el = $('#view');
  if (!route.repo) {
    renderTop(route, null);
    el.innerHTML = '';
    mounted = { key, inst: home.mount(el, { href }) };
    return;
  }
  const store = storeFor(route.repo);
  renderTop(route, store);
  if (!store.model) {
    el.innerHTML = `<div class="loading"><span class="spin" style="display:inline-grid">${icon.sync(16)}</span>正在读取 ${esc(route.repo)}…</div>`;
    try {
      await store.loadModel();
    } catch (e) {
      el.innerHTML = `<div class="error-box"><b>读不了这个仓库</b><p class="t2">${esc(e.message)}</p><a class="link" href="#/">回到仓库列表</a></div>`;
      return;
    }
    if (my !== routeToken) return;
    store.loadPrs();
    store.loadWorktrees().catch(() => {});
  }
  renderTop(route, store);
  el.innerHTML = '';
  const def = VIEWS.find((v) => v.id === route.view);
  const ctx = {
    repo: route.repo,
    store,
    model: store.model,
    params: route.params,
    href: (view, params) => href(route.repo, view, params),
    go: (view, params) => go(route.repo, view, params),
    setParams,
  };
  mounted = { key, inst: def.mod.mount(el, ctx) };
  document.title = `${route.repo} · ${def.label} · BranchMap`;
}

// 点链接、改 location.hash、前进后退都会触发 popstate（hashchange 会紧跟着再来一次，不用再听）
window.addEventListener('popstate', route_);
// 回到这个窗口时看一眼仓库有没有变（新提交、切分支、改文件）
let lastFocusCheck = Date.now();
window.addEventListener('focus', async () => {
  const route = parse();
  if (!route.repo || Date.now() - lastFocusCheck < 15000) return;
  lastFocusCheck = Date.now();
  const store = storeFor(route.repo);
  store.loadWorktrees(true).catch(() => {});
  const changed = await store.loadModel().catch(() => false);
  if (changed && parse().repo === route.repo) {
    toast('仓库有新变化，已刷新');
    mounted?.inst?.unmount?.();
    mounted = null;
    route_();
  }
});
route_();
