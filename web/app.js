// 外壳：顶栏（看板 · 分支图 · 成员 + 当前项目切换 + 右侧图标）和路由，一层一层往下：
//   #/                       看板：所有项目要注意的问题、主线与环境、谁在忙、本机
//   #/p/<项目>               分支图（左：主线与分支；中：提交图；右：分支 → 提交 → 文件）
//   #/p/<项目>/people        成员卡片
//   #/p/<项目>/people/<人>   一个人的详情
// 服务端的数据一变就推过来，当前页面就地刷新。
import { $, esc, icon, ago, stamp, picker, toast, closePop, worst, levelIcon } from './lib/util.js';
import { listProjects, storeFor, connectEvents, onServerChange } from './lib/api.js';
import { closeChanges } from './lib/changes.js';
import * as board from './views/board.js';
import * as project from './views/project.js';
import * as members from './views/members.js';

const VIEWS = {
  board: { mod: board, label: '看板' },
  graph: { mod: project, label: '分支图', model: true },
  people: { mod: members, label: '成员' },
};

let projectList = null;
let mounted = null; // { key, inst }
let live = true;

function parse() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = h.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(query);
  if (parts[0] === 'p' && parts[1]) {
    const view = parts[2] === 'people' ? 'people' : 'graph';
    return { id: parts[1], view, sub: view === 'people' ? parts[3] ?? null : null, params };
  }
  return { id: null, view: 'board', sub: null, params };
}
export function href(id, view = 'graph', params = {}, sub = null) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
  const path = view === 'people' ? `/people${sub != null ? '/' + encodeURIComponent(sub) : ''}` : '';
  return `#/p/${encodeURIComponent(id)}${path}${q ? '?' + q : ''}`;
}
function setParams(patch) {
  const r = parse();
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === '' || v === false) r.params.delete(k);
    else r.params.set(k, String(v));
  }
  history.replaceState(null, '', href(r.id, r.view, Object.fromEntries(r.params), r.sub));
}
function currentProject(route = parse()) {
  if (route.id) return route.id;
  let last = null;
  try {
    last = localStorage.getItem('bm-project');
  } catch { /* 无痕模式 */ }
  const ids = projectList?.projects.map((p) => p.id) ?? [];
  return ids.includes(last) ? last : ids[0] ?? null;
}

/* ---------- 顶栏 ---------- */
function renderTop() {
  const route = parse();
  const cur = currentProject(route);
  const P = projectList?.projects.find((p) => p.id === cur);
  const o = route.id ? storeFor(route.id).overview : null;
  const tab = (v, ic, label, url) => `<a class="tab" href="${url}" ${route.view === v ? 'aria-current="page"' : ''}>${icon[ic](14)}<span>${label}</span></a>`;
  let right = '';
  if (route.id && o?.ready) {
    const hl = o.health.filter((h) => h.level !== 'info');
    const lv = hl.some((h) => h.level === 'critical') ? 'critical' : hl.length ? 'warning' : null;
    const s = o.sync ?? {};
    const led = s.status === 'syncing' || s.status === 'cloning' ? 'busy' : s.status === 'error' ? 'critical' : 'good';
    const tip = s.status === 'error' ? `同步失败：${s.error ?? ''}\n点击重试` : `${s.lastOk ? '云端 ' + ago(Math.floor(s.lastOk / 1000)) + '同步（' + stamp(Math.floor(s.lastOk / 1000)) + '）' : '还没同步'}\n点击立即同步`;
    right = `${lv ? `<button class="tb hl ${lv}" data-health data-pop-anchor data-tip="${esc(hl.map((h) => h.title).join('\n'))}">${levelIcon(lv, 14)}<span>${hl.length}</span></button>` : ''}
      <button class="tb" data-sync data-tip="${esc(tip)}">${icon.cloud(15)}<i class="led ${led}"></i></button>`;
  }
  $('#top').innerHTML = `
    <a class="brand" href="#/" data-tip="BranchMap">${icon.logo(20)}</a>
    <nav class="tabs">
      ${tab('board', 'home', '看板', '#/')}
      ${cur ? tab('graph', 'branch', '分支图', href(cur)) : ''}
      ${cur ? tab('people', 'people', '成员', href(cur, 'people')) : ''}
    </nav>
    ${cur ? `<button class="pswitch" data-switch data-pop-anchor data-tip="切换项目 (Ctrl K)"><i class="led ${P ? (P.ready ? worst(P.health) : 'busy') : 'info'}"></i><b>${esc(P?.name ?? cur)}</b>${icon.chevronDown(11)}</button>` : ''}
    <span class="grow"></span>
    ${live ? '' : `<span class="tb warnc" data-tip="和本机服务的连接断了，正在重连">${icon.alert(14)}</span>`}
    ${right}
    <button class="tb" data-theme data-tip="深色 / 浅色">${document.documentElement.dataset.theme === 'dark' ? icon.sun(15) : icon.moon(15)}</button>`;
}

async function openSwitch(anchor) {
  projectList = await listProjects().catch(() => projectList);
  const route = parse();
  picker(anchor, {
    items: (projectList?.projects ?? []).map((p) => ({ value: p.id, label: p.name, group: p.group ?? '项目', hint: p.ready ? String(p.inFlight ?? '') : '', html: `<i class="led ${p.ready ? worst(p.health) : 'busy'}"></i><span class="ell">${esc(p.name)}</span>` })),
    placeholder: '',
    selected: [currentProject(route)],
    width: 280,
    onPick: (id) => {
      location.hash = href(id, route.view === 'people' ? 'people' : 'graph');
    },
  });
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    const b = document.querySelector('[data-switch]');
    if (b) openSwitch(b);
  }
});
document.addEventListener('click', async (e) => {
  const t = e.target.closest('#top [data-switch], #top [data-sync], #top [data-theme], #top [data-health]');
  if (!t) return;
  const route = parse();
  if (t.dataset.switch !== undefined) openSwitch(t);
  else if (t.dataset.theme !== undefined) {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('bm-theme', next);
    } catch { /* 无痕模式 */ }
    renderTop();
    mounted?.inst?.theme?.();
  } else if (t.dataset.sync !== undefined) {
    const store = storeFor(route.id);
    t.innerHTML = `${icon.cloud(15)}<i class="led busy"></i>`;
    const r = await store.sync().catch((err) => ({ ok: false, error: err.message }));
    if (!r.ok) toast('同步失败：' + r.error);
    await store.changed('sync');
  } else if (t.dataset.health !== undefined) {
    const o = storeFor(route.id).overview;
    picker(t, {
      items: o.health.map((h, i) => ({ value: String(i), label: h.title, html: `${levelIcon(h.level, 13)}<span style="white-space:normal;line-height:1.45">${esc(h.title)}${h.detail ? `<br><span class="muted" style="font-size:11.5px">${esc(h.detail)}</span>` : ''}</span>` })),
      placeholder: '',
      width: 380,
      onPick: () => {},
    });
  }
});

/* ---------- 挂载页面 ---------- */
let token = 0;
async function route_() {
  const my = ++token;
  closePop();
  closeChanges();
  const route = parse();
  const key = `${route.id}|${route.view}`;
  renderTop();
  if (mounted?.key === key && mounted.inst?.update) {
    mounted.inst.update(route.params, route.sub);
    return;
  }
  mounted?.inst?.unmount?.();
  mounted = null;
  const el = $('#view');
  const def = VIEWS[route.view];
  if (!route.id) {
    el.innerHTML = '';
    document.title = 'BranchMap';
    mounted = { key, inst: def.mod.mount(el, { href }) };
    return;
  }
  try {
    localStorage.setItem('bm-project', route.id);
  } catch { /* 无痕模式 */ }
  const store = storeFor(route.id);
  watchStore(route.id);
  if (!store.overview || (def.model && (!store.model || store.modelStale))) {
    el.innerHTML = `<div class="quiet pad"><span class="spin" style="display:inline-grid">${icon.sync(16)}</span></div>`;
    try {
      await store.loadOverview();
      if (store.overview.ready && def.model) {
        await store.loadModel();
        store.loadWorktrees().catch(() => {});
      }
    } catch (e) {
      if (my !== token) return;
      el.innerHTML = `<div class="quiet pad">${icon.alert(14)} ${esc(e.message)}</div>`;
      return;
    }
    if (my !== token) return;
  }
  renderTop();
  el.innerHTML = '';
  if (!store.overview.ready) {
    const s = store.overview.sync ?? {};
    el.innerHTML = `<div class="quiet pad">${s.status === 'error' ? `${icon.alert(14)} ${esc(s.error ?? '')}` : `<span class="spin" style="display:inline-grid">${icon.sync(16)}</span> 正在建云端副本`}</div>`;
    mounted = { key, inst: { refresh: () => { if (store.overview?.ready) { mounted = null; route_(); } } } };
    return;
  }
  const ctx = {
    id: route.id,
    store,
    get overview() {
      return store.overview;
    },
    params: route.params,
    sub: route.sub,
    href: (view, params, sub) => href(route.id, view, params, sub),
    setParams,
  };
  mounted = { key, inst: def.mod.mount(el, ctx) };
  document.title = `${store.overview.name} · ${def.label} · BranchMap`;
}

/* ---------- 实时刷新 ---------- */
let listTimer = null;
onServerChange((e) => {
  clearTimeout(listTimer);
  listTimer = setTimeout(async () => {
    projectList = await listProjects().catch(() => projectList);
    renderTop();
  }, 1500);
  if (!parse().id) mounted?.inst?.refresh?.(e);
});
function watchStore(id) {
  const store = storeFor(id);
  if (store.watched) return;
  store.watched = true;
  store.on((what) => {
    if (what !== 'overview' || parse().id !== id) return;
    renderTop();
    mounted?.inst?.refresh?.();
  });
}
window.addEventListener('popstate', route_);
let lastFocus = 0;
window.addEventListener('focus', () => {
  const route = parse();
  if (!route.id || Date.now() - lastFocus < 20000) return;
  lastFocus = Date.now();
  storeFor(route.id).refresh().catch(() => {});
});
setInterval(renderTop, 60000);

connectEvents((ok) => {
  if (ok === live) return;
  live = ok;
  renderTop();
  const r = parse();
  if (ok && r.id) storeFor(r.id).changed('reconnect');
  if (ok && !r.id) mounted?.inst?.refresh?.({});
});
listProjects().then((l) => {
  projectList = l;
  renderTop();
}).catch(() => {});
route_();
