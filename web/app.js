// 外壳：左侧导航栏（看板 · 分支图 · 成员 + 项目列表），右边顶栏（位置 + 添加项目）和内容，一层一层往下：
//   #/                       看板：所有项目要注意的问题、主线与环境、谁在忙、本机
//   #/p/<项目>               分支图（左：主线与分支；中：提交图；右：分支 → 提交 → 文件）
//   #/p/<项目>/people        成员卡片
//   #/p/<项目>/people/<人>   一个人的详情
// 服务端的数据一变就推过来，当前页面就地刷新。
import { $, esc, icon, ago, stamp, picker, toast, closePop, worst, levelIcon, avatar, hideTip } from './lib/util.js';
import { listProjects, storeFor, connectEvents, onServerChange, request } from './lib/api.js';
import { closeChanges } from './lib/changes.js';
import { openAddProject } from './lib/addproject.js';
import { startAmbient } from './lib/ambient.js';
import { openSettings } from './lib/settings.js';
import { sortable, isDragging } from './lib/sortable.js';
import { resizer } from './lib/resize.js';
import { watchMid } from './lib/measure.js';
import * as board from './views/board.js';
import * as project from './views/project.js';
import * as members from './views/members.js';
import * as branches from './views/branches.js';

const VIEWS = {
  board: { mod: board, label: '看板' },
  graph: { mod: project, label: '分支图', model: true },
  people: { mod: members, label: '成员' },
  branches: { mod: branches, label: '分支', model: true },
};

let projectList = null;
let mounted = null; // { key, inst }
let live = true;
let me = null; // 本机 Git 身份 + GitHub 头像

function parse() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = h.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(query);
  if (parts[0] === 'p' && parts[1]) {
    const view = parts[2] === 'people' ? 'people' : parts[2] === 'branches' ? 'branches' : 'graph';
    return { id: parts[1], view, sub: view === 'people' ? parts[3] ?? null : null, params };
  }
  return { id: null, view: 'board', sub: null, params };
}
export function href(id, view = 'graph', params = {}, sub = null) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
  const path = view === 'people' ? `/people${sub != null ? '/' + encodeURIComponent(sub) : ''}` : view === 'branches' ? '/branches' : '';
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
const groupsOf = () => [...new Set((projectList?.projects ?? []).map((p) => p.group).filter(Boolean))];

/* ---------- 左侧导航栏 ---------- */
function renderSide() {
  // 正在拖项目排序：先不重画，松手后再画
  if (isDragging()) return void (sidePending = true);
  const route = parse();
  const cur = currentProject(route);
  const list = projectList?.projects ?? [];
  const groups = new Map();
  for (const p of list) {
    const g = p.group ?? '项目';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  // 在看板（没进项目）时，这几个入口去的是上次看的项目：悬停写明是哪个
  const curName = list.find((p) => p.id === cur)?.name ?? cur;
  // 收起时只剩图标：名字都放进悬停提示
  const mini = document.documentElement.classList.contains('side-mini');
  const nav = (v, ic, label, url, on) => {
    const tip = v !== 'board' && !route.id ? `${curName} 的${label}` : mini ? label : '';
    return `<a class="nv" href="${url}" ${on ? 'aria-current="page"' : ''}${tip ? ` data-tip="${esc(tip)}"` : ''}>${icon[ic](15)}<span>${label}</span></a>`;
  };
  const item = (p) => {
    const lv = !p.ready ? (p.sync?.status === 'error' ? 'critical' : 'busy') : worst(p.health);
    const tip = !p.ready ? (p.sync?.status === 'error' ? '云端副本建不起来' : '正在建云端副本') : lv === 'critical' ? `${p.health.critical} 个严重问题` : lv === 'warning' ? `${p.health.warning} 个需要注意` : '';
    const target = route.id ? href(p.id, route.view === 'people' || route.view === 'branches' ? route.view : 'graph') : href(p.id);
    return `<div class="pj${p.id === route.id ? ' on' : ''}" data-pj="${esc(p.id)}" data-group="${esc(p.group ?? '')}">
      <a href="${target}"${mini ? ` data-tip="${esc(p.name + (tip ? '\n' + tip : ''))}"` : ''}><span class="ri">${icon.repo(13)}</span><span class="pini">${esc([...p.name][0]?.toUpperCase() ?? '?')}</span><span class="nm">${esc(p.name)}</span>${lv === 'critical' || lv === 'warning' || lv === 'busy' ? `<i class="sd ${lv}" data-tip="${esc(tip)}"></i>` : ''}${p.ready && p.inFlight ? `<span class="ct" data-tip="在途的工作">${p.inFlight}</span>` : ''}</a>
      <button class="pm" data-pmenu="${esc(p.id)}" data-pop-anchor data-tip="更多">${icon.kebab(13)}</button>
    </div>`;
  };
  const failed = list.filter((p) => p.sync?.status === 'error').length;
  const keep = $('#side .pjs')?.scrollTop ?? 0; // 重画不丢项目列表的滚动位置
  $('#side').innerHTML = `
    <a class="logo" href="#/">${icon.logo(22)}<b>BranchMap</b></a>
    <button class="sbs" data-search data-pop-anchor${mini ? ' data-tip="搜索项目 (Ctrl K)"' : ''}>${icon.search(14)}<span>搜索项目</span><kbd>Ctrl K</kbd></button>
    <p class="lab">浏览</p>
    <nav class="nvs">
      ${nav('board', 'home', '看板', '#/', route.view === 'board')}
      ${cur ? nav('graph', 'flow', '分支图', href(cur), route.view === 'graph') : ''}
      ${cur ? nav('branches', 'branch', '分支', href(cur, 'branches'), route.view === 'branches') : ''}
      ${cur ? nav('people', 'people', '成员', href(cur, 'people'), route.view === 'people') : ''}
    </nav>
    <div class="pjs">
      <p class="lab"><span>项目</span><button class="icon-btn" data-add data-tip="添加项目">${icon.plus(13)}</button></p>
      ${[...groups].map(([g, ps]) => `${groups.size > 1 ? `<p class="lab sub" data-grp="${esc(ps[0].group ?? '')}">${esc(g)}</p>` : ''}${ps.map(item).join('')}`).join('')}
      ${!projectList ? '<div class="quiet"><span class="spin" style="display:inline-grid">' + icon.sync(12) + '</span></div>' : ''}
    </div>
    <div class="sfoot">
      <button class="meb" data-me data-tip="${esc([me?.name, me?.login ? '@' + me.login : '', me?.email, live ? (failed ? `${failed} 个项目云端同步失败` : '实时连接正常，数据变了会自动刷新') : '和本机服务的连接断了，正在重连'].filter(Boolean).join('\n'))}">
        <span class="mav">${avatar(me ?? { name: '?' }, 28)}<i class="led ${!live ? 'warning' : failed ? 'critical' : 'good'}"></i></span>
        <span class="mnm"><b>${esc(me?.name ?? '本机')}</b>${me?.login ? `<span>@${esc(me.login)}</span>` : ''}</span>
      </button>
      <button class="icon-btn" data-theme data-tip="深色 / 浅色">${document.documentElement.dataset.theme === 'dark' ? icon.sun(14) : icon.moon(14)}</button>
      <button class="icon-btn" data-side-mini data-tip="${mini ? '展开侧栏' : '收起侧栏'}">${icon.sidebar(14)}</button>
    </div>`;
  $('#side .pjs').scrollTop = keep;
}
let sidePending = false;
// 侧栏宽度：拖右边缘
resizer($('#rz-side'), { target: $('#app'), prop: '--side-w', key: 'side', min: 200, max: 420, dir: 1, def: 252 });

/* ---------- 项目拖动排序：按住上下拖，拖过分组标题就换组；顺序写回配置，看板跟着同一个顺序 ---------- */
sortable($('#side'), {
  item: '[data-pj]',
  ignore: '[data-pmenu]',
  scroller: () => $('#side .pjs'),
  onDrop: async (order) => {
    const byId = new Map((projectList?.projects ?? []).map((p) => [p.id, p]));
    // 没有分组标题时（只有一组）各自保留原来的分组
    const next = order.map((x) => ({ id: x.id, group: x.group === undefined ? byId.get(x.id)?.group ?? null : x.group || null }));
    if (projectList) projectList = { ...projectList, projects: next.map((x) => ({ ...byId.get(x.id), group: x.group })).filter((p) => p.id) };
    renderSide();
    try {
      await request('/api/projects/order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order: next }) });
    } catch (e) {
      toast('排序没存上：' + e.message);
      projectList = await listProjects().catch(() => projectList);
      renderSide();
    }
  },
});
document.addEventListener('pointerup', () => setTimeout(() => {
  if (sidePending && !isDragging()) {
    sidePending = false;
    renderSide();
  }
}, 0));

/** 「我」在当前项目里是哪个成员（按名字 / GitHub 账号对上）。 */
function myPersonId(o) {
  if (!me || !o?.persons) return null;
  const keys = [me.name, me.login].filter(Boolean).map((x) => x.toLowerCase());
  const p = o.persons.find((x) => [x.name, ...(x.names ?? []), x.login].filter(Boolean).some((n) => keys.includes(n.toLowerCase())));
  return p ? p.id : null;
}

/* ---------- 顶栏：在哪（可点回上一层）+ 当前项目的状态 + 添加项目 ---------- */
function renderTop() {
  const route = parse();
  const o = route.id ? storeFor(route.id).overview : null;
  const P = route.id ? projectList?.projects.find((p) => p.id === route.id) : null;
  // 左边是在哪一层（项目名在右边的项目选择器里，不重复）
  const crumbs = [];
  const name = route.id ? o?.name ?? P?.name ?? route.id : null;
  if (route.id) {
    if (route.view === 'people' && route.sub != null) {
      const person = o?.persons?.[Number(route.sub)];
      crumbs.push(`<a href="${href(route.id, 'people')}">成员</a>`, `<b>${avatar(person, 16)}${esc(person?.name ?? '')}</b>`);
    } else crumbs.push(`<b>${VIEWS[route.view].label}</b>`);
  } else crumbs.push('<b>看板</b>');
  // 项目选择器：当前在哪个项目、点开切换；后面紧跟着的问题 / 同步 / 设置都是这个项目的
  const lvP = P && P.ready ? worst(P.health) : null;
  const sel = `<button class="psel" data-switch data-pop-anchor data-tip="切换项目 (Ctrl K)">${icon.repo(13)}<span class="ell">${esc(name ?? '全部项目')}</span>${lvP === 'critical' || lvP === 'warning' ? `<i class="sd ${lvP}"></i>` : ''}${icon.chevronDown(11)}</button>`;
  let status = '';
  if (route.id && o?.ready) {
    const hl = o.health.filter((h) => h.level !== 'info');
    const lv = hl.some((h) => h.level === 'critical') ? 'critical' : hl.length ? 'warning' : null;
    const s = o.sync ?? {};
    const led = s.status === 'syncing' || s.status === 'cloning' ? 'busy' : s.status === 'error' ? 'critical' : 'good';
    const tip = s.status === 'error' ? `同步失败：${s.error ?? ''}\n点击重试` : `${s.lastOk ? '云端 ' + ago(Math.floor(s.lastOk / 1000)) + '同步（' + stamp(Math.floor(s.lastOk / 1000)) + '）' : '还没同步'}\n点击立即同步`;
    status = `${lv ? `<button class="tb hl ${lv}" data-health data-pop-anchor data-tip="${esc(hl.map((h) => h.title).join('\n'))}">${levelIcon(lv, 14)}<span>${hl.length}</span></button>` : ''}
      <button class="tb" data-sync data-tip="${esc(tip)}">${icon.cloud(15)}<i class="led ${led}"></i></button>
      ${o.web ? `<a class="tb" href="${esc(o.web)}" target="_blank" rel="noreferrer" data-tip="${esc(o.slug ?? o.web)}">${icon.ext(14)}</a>` : ''}
      <button class="tb" data-settings data-tip="项目设置：主线分支、环境">${icon.gear(15)}</button>`;
  }
  $('#top').innerHTML = `
    <nav class="crumbs">${crumbs.join(`<i>${icon.chevronRight(11)}</i>`)}</nav>
    <span class="grow"></span>
    ${sel}
    ${status}
    <button class="btn primary addp" data-add>${icon.plus(13)}添加项目</button>`;
}
const renderChrome = () => {
  renderSide();
  renderTop();
};

/* ---------- 交互 ---------- */
async function openSwitch(anchor) {
  projectList = await listProjects().catch(() => projectList);
  const route = parse();
  picker(anchor, {
    items: (projectList?.projects ?? []).map((p) => ({ value: p.id, label: p.name, group: p.group ?? '项目', html: `<i class="led ${p.ready ? worst(p.health) : 'busy'}"></i><span class="ell">${esc(p.name)}</span>` })),
    placeholder: '',
    selected: [currentProject(route)],
    width: 280,
    onPick: (id) => {
      location.hash = href(id, route.view === 'people' || route.view === 'branches' ? route.view : 'graph');
    },
  });
}

/** 健康信号的 link → 去哪（页面上所有「问题」都能点过去）。 */
export function linkHref(id, link) {
  if (!link) return href(id);
  if (link.view === 'branches') return href(id, 'branches', { f: link.f });
  if (link.view === 'settings') return href(id, 'graph', { settings: 1 });
  return href(id, 'graph', { c: link.c, b: link.b, t: link.t, env: link.env });
}
function addProject() {
  openAddProject({
    groups: groupsOf(),
    onAdded: async (id) => {
      projectList = await listProjects().catch(() => projectList);
      renderSide();
      if (id) location.hash = href(id);
      toast('已添加，正在建云端副本');
    },
  });
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openSwitch($('#side [data-search]'));
  }
});
document.addEventListener('click', async (e) => {
  const t = e.target.closest('#side [data-add], #top [data-add], #top [data-settings], #side [data-search], #side [data-theme], #side [data-side-mini], #side [data-me], #side [data-pmenu], #top [data-sync], #top [data-health], #top [data-switch]');
  if (!t) return;
  const route = parse();
  if (t.dataset.add !== undefined) addProject();
  else if (t.dataset.settings !== undefined) {
    const store = storeFor(route.id);
    const model = await store.loadModel().catch((err) => toast(err.message));
    if (model) openSettings({ id: route.id, name: store.overview?.name ?? route.id, model });
  }
  else if (t.dataset.me !== undefined) {
    // 点「我」：去当前项目里我的成员详情；认不出是谁就去成员列表
    const id = currentProject(route);
    if (!id) return;
    const store = storeFor(id);
    const o = store.overview ?? (await store.loadOverview().catch(() => null));
    const pid = myPersonId(o);
    location.hash = href(id, 'people', {}, pid);
  }
  else if (t.dataset.search !== undefined || t.dataset.switch !== undefined) openSwitch(t);
  else if (t.dataset.sideMini !== undefined) {
    // 收起 / 展开侧栏，记在浏览器里
    const on = document.documentElement.classList.toggle('side-mini');
    try {
      localStorage.setItem('bm-side-mini', on ? '1' : '');
    } catch { /* 无痕模式 */ }
    hideTip();
    renderSide();
  } else if (t.dataset.theme !== undefined) {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('bm-theme', next);
    } catch { /* 无痕模式 */ }
    renderSide();
    mounted?.inst?.theme?.();
  } else if (t.dataset.pmenu !== undefined) {
    e.preventDefault();
    const id = t.dataset.pmenu;
    const P = projectList?.projects.find((p) => p.id === id);
    picker(t, {
      items: [
        { value: 'sync', label: '同步', html: `${icon.cloud(13)}<span>立即同步</span>` },
        ...(P?.web ? [{ value: 'web', label: 'GitHub', html: `${icon.ext(13)}<span>在 GitHub 打开</span>` }] : []),
        { value: 'remove', label: '移除', html: `${icon.close(13)}<span>移除项目</span><span class="faint" style="margin-left:auto;font-size:11px">不删任何东西</span>` },
      ],
      placeholder: '',
      width: 240,
      onPick: async (v) => {
        if (v === 'sync') {
          const r = await request(`/api/p/${encodeURIComponent(id)}/sync`, { method: 'POST' }).catch((err) => ({ ok: false, error: err.message }));
          toast(r.ok ? '已同步' : '同步失败：' + r.error);
        } else if (v === 'web') window.open(P.web, '_blank', 'noreferrer');
        else if (v === 'remove') {
          if (!confirm(`从 BranchMap 里移除「${P?.name ?? id}」？\n只是不再显示，你的仓库和云端副本都不会被删；之后可以在「添加项目」里加回来。`)) return;
          await request(`/api/p/${encodeURIComponent(id)}/remove`, { method: 'POST' }).catch((err) => toast(err.message));
          projectList = await listProjects().catch(() => projectList);
          if (route.id === id) location.hash = '#/';
          renderSide();
        }
      },
    });
  } else if (t.dataset.sync !== undefined) {
    const store = storeFor(route.id);
    t.innerHTML = `${icon.cloud(15)}<i class="led busy"></i>`;
    const r = await store.sync().catch((err) => ({ ok: false, error: err.message }));
    if (!r.ok) toast('同步失败：' + r.error);
    await store.changed('sync');
  } else if (t.dataset.health !== undefined) {
    const o = storeFor(route.id).overview;
    picker(t, {
      items: o.health.map((h, i) => ({ value: String(i), label: h.title, html: `${levelIcon(h.level, 13)}<span style="white-space:normal;line-height:1.45;flex:1">${esc(h.title)}${h.detail ? `<br><span class="muted" style="font-size:11.5px">${esc(h.detail)}</span>` : ''}</span>${h.link ? icon.chevronRight(12) : ''}` })),
      placeholder: '',
      width: 400,
      onPick: (v) => {
        const h = o.health[Number(v)];
        if (h?.link) location.hash = linkHref(route.id, h.link);
      },
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
  renderChrome();
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
    mounted = { key, inst: def.mod.mount(el, { href, addProject, linkHref }) };
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
    me: () => myPersonId(store.overview),
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
    renderSide();
    if (e.what === 'projects' && !parse().id) mounted?.inst?.refresh?.(e);
  }, e.what === 'projects' ? 100 : 1500);
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
setInterval(renderChrome, 60000);

// 和本机服务断开：超过 3 秒才在顶部提示（刷新页面、服务重启这种一闪而过的不打扰），连回来自动消失
let connTimer = 0;
function connBanner(ok) {
  clearTimeout(connTimer);
  let el = document.getElementById('conn');
  if (ok) {
    if (el && !el.hidden) toast('已重新连上');
    if (el) el.hidden = true;
    return;
  }
  connTimer = setTimeout(() => {
    if (!el) {
      el = document.createElement('div');
      el.id = 'conn';
      el.innerHTML = `<span class="spin" style="display:inline-grid">${icon.sync(13)}</span><span>和本机服务的连接断了，正在重连…</span>`;
      document.body.append(el);
    }
    el.hidden = false;
  }, 3000);
}
connectEvents((ok) => {
  if (ok === live) return;
  live = ok;
  connBanner(ok);
  renderSide();
  const r = parse();
  if (ok && r.id) storeFor(r.id).changed('reconnect');
  if (ok && !r.id) mounted?.inst?.refresh?.({});
});
listProjects().then((l) => {
  projectList = l;
  renderChrome();
}).catch(() => {});
startAmbient();
watchMid();
request('/api/me').then((m) => {
  me = m;
  renderSide();
}).catch(() => {});
route_();
