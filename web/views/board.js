// 看板（首页）：所有项目放在一起看，回答「每个项目的工作走到哪了、要我做什么决定」。每样东西都能点进去。
//   项目（左，主体）—— 每个项目一块：
//       线路图：进行中的分支（虚线 = 还没合进去）汇入 dev，dev 汇入 main；环境是路上的站点，
//               已进 dev 等上线的分支是停在 dev 上的小点，待上线 / 没回合的数量标在 dev → main 的连线上
//       决策：这个项目要处理的问题，紧挨着它的线路图
//   本机（右）—— 我这台电脑上没推送的分支、没提交的改动
//   成员（右）—— 谁在忙：手上的分支、最近一次动静（跨项目合并同一个人）
// 项目的顺序和左侧栏一致（侧栏里拖动排序）。模块互不依赖：各自只读看板数据里自己那一块。
import { esc, icon, ago, avatar, levelIcon, prChip, toast } from '../lib/util.js';
import { request } from '../lib/api.js';
import { MAIN, DEV, branchColor } from '../lib/colors.js';
import { resizer } from '../lib/resize.js';

const LEVEL = { critical: 0, warning: 1, info: 2 };
// 线路图的几何：分支一行矮一点，主线一行高一点（站点名字写在站点下面）
const BH = 26;
const RH = 42;
const MAX_BRANCHES = 5;
const J1 = 0.34; // 分支在这里转下去汇入 dev
const J2 = 0.76; // dev 在这里转下去汇入 main
const DAY = 86400;
const STALE_SYNC = 30 * 60 * 1000; // 云端数据超过这么久没更新，看板上标出来

function loadFold() {
  try {
    return new Set(JSON.parse(localStorage.getItem('bm-board-fold') ?? '[]'));
  } catch {
    return new Set();
  }
}
function saveFold(s) {
  try {
    localStorage.setItem('bm-board-fold', JSON.stringify([...s]));
  } catch { /* 无痕模式 */ }
}

export function mount(el, { href, addProject, linkHref }) {
  el.innerHTML = `<div class="page"><div class="board" data-root><div class="quiet pad"><span class="spin" style="display:inline-grid">${icon.sync(16)}</span></div></div></div>`;
  const root = el.querySelector('[data-root]');
  let data = null;
  let timer = null;
  const fold = loadFold();
  const infoOpen = new Set();
  const localOpen = new Set(); // 本机模块里点开了哪些项目
  const geo = new Map(); // 项目 id -> 线路图几何（画线要等量出宽度）

  async function load() {
    try {
      data = await request('/api/board');
      draw();
    } catch (e) {
      root.innerHTML = `<div class="quiet pad">${icon.alert(14)} ${esc(e.message)}</div>`;
    }
  }

  const P = () => data.projects.filter((p) => p.ready);
  const projTag = (p) => `<span class="ptag">${icon.repo(11)}<span>${esc(p.name)}</span></span>`;

  /* ================= 项目：一块一个 ================= */
  function projectBlock(p) {
    if (!p.ready) {
      const err = p.sync?.status === 'error';
      return `<section class="mod pblk off" data-p="${esc(p.id)}">
        <div class="phd"><a class="pn" href="${href(p.id)}">${icon.repo(14)}<span>${esc(p.name)}</span></a><span class="grow"></span>
        <span class="quiet" data-tip="${esc(err ? `云端副本建不起来：${p.sync.error ?? ''}` : '正在建云端副本')}">${err ? levelIcon('critical', 14) : `<span class="spin" style="display:inline-grid">${icon.sync(13)}</span>`}</span></div>
      </section>`;
    }
    const folded = fold.has(p.id);
    const lv = p.health.critical ? 'critical' : p.health.warning ? 'warning' : null;
    const t = p.trunk ?? {};
    const act = p.lanes?.active ?? [];
    const stat = folded
      ? `<span class="pstat">
          <span data-tip="进行中的分支">${icon.branch(11)}${act.length}</span>
          ${t.dev ? `<span class="${t.ahead ? '' : 'faint'}" data-tip="${esc(`待上线：${t.ahead ?? 0} 个提交在 ${t.dev}、还没进 ${t.main}`)}">${icon.arrowRight(11)}${t.ahead ?? 0}</span>` : ''}
          ${t.behind ? `<span class="warnc" data-tip="${esc(`没回合：${t.main} 上有 ${t.behind} 个提交不在 ${t.dev}`)}">${icon.arrowLeft(11)}${t.behind}</span>` : ''}
        </span>`
      : '';
    return `<section class="mod pblk${folded ? ' folded' : ''}" data-p="${esc(p.id)}">
      <div class="phd">
        <a class="pn" href="${href(p.id)}" data-tip="打开分支图">${icon.repo(14)}<span>${esc(p.name)}</span></a>
        ${lv ? `<span data-tip="${esc(`${p.health.critical ? p.health.critical + ' 个严重问题 ' : ''}${p.health.warning ? p.health.warning + ' 个需要注意' : ''}`)}">${levelIcon(lv, 13)}</span>` : ''}
        ${stat}
        <span class="grow"></span>
        <span class="avs" data-tip="近 7 天有提交的人">${p.activePeople.slice(0, 5).map((id) => avatar(p.persons[id], 20)).join('')}</span>
        ${syncMark(p)}
        <span class="muted pt" data-tip="${esc(p.latest ? `${p.latest.name ?? ''}：${p.latest.subject}` : '')}">${p.latest ? ago(p.latest.ctime) : ''}</span>
        <span class="plinks">
          <a class="icon-btn" href="${href(p.id)}" data-tip="分支图">${icon.flow(13)}</a>
          <a class="icon-btn" href="${href(p.id, 'branches')}" data-tip="分支">${icon.branch(13)}</a>
          <a class="icon-btn" href="${href(p.id, 'people')}" data-tip="成员">${icon.people(13)}</a>
          ${p.web ? `<a class="icon-btn" href="${esc(p.web)}" target="_blank" rel="noreferrer" data-tip="在 GitHub 打开">${icon.ext(12)}</a>` : ''}
        </span>
        <button class="icon-btn fold" data-fold="${esc(p.id)}" data-tip="${folded ? '展开' : '收起'}">${folded ? icon.chevronRight(13) : icon.chevronDown(13)}</button>
      </div>
      ${folded ? '' : lineMap(p) + decisions(p)}
    </section>`;
  }

  /** 云端同步状态：正常时只是一朵淡色的云（悬停看时间）；停更超过 30 分钟或同步失败，变成警告色并写明停在多久以前 */
  function syncMark(p) {
    const s = p.sync ?? {};
    const age = s.lastOk ? Date.now() - s.lastOk : null;
    const stale = s.status === 'error' || age == null || age > STALE_SYNC;
    const when = s.lastOk ? ago(Math.floor(s.lastOk / 1000)) : '';
    const tip = s.status === 'error' ? `云端同步失败：${s.error ?? ''}${when ? `
数据停在 ${when}` : ''}` : !s.lastOk ? '还没从云端同步过' : stale ? `云端很久没同步了，数据停在 ${when}` : `云端 ${when}同步`;
    return `<span class="psync${stale ? ' stale' : ''}" data-tip="${esc(tip)}">${icon.cloud(13)}${stale && when ? `<em>${when}</em>` : ''}</span>`;
  }

  /* ---------- 线路图 ---------- */
  function lineMap(p) {
    const t = p.trunk ?? {};
    const trunk = { main: t.main, dev: t.dev };
    const act = p.lanes?.active ?? [];
    const waiting = p.lanes?.waiting ?? [];
    const shown = act.slice(0, MAX_BRANCHES);
    const rows = [];
    for (const b of shown) rows.push({ kind: 'b', b, h: BH });
    if (act.length > shown.length) rows.push({ kind: 'more', n: act.length - shown.length, h: BH });
    if (!act.length) rows.push({ kind: 'none', h: BH });
    if (t.dev) rows.push({ kind: 'rail', key: 'dev', name: t.dev, color: DEV, h: RH });
    if (t.main) rows.push({ kind: 'rail', key: 'main', name: t.main, color: MAIN, h: RH });
    let y = 0;
    for (const r of rows) {
      r.y = y + (r.kind === 'rail' ? 14 : r.h / 2);
      y += r.h;
    }
    const height = y + 6;
    const railRows = rows.filter((r) => r.kind === 'rail');
    const target = railRows[0] ?? null; // 分支汇入的那条（有 dev 就是 dev）
    const devRow = railRows.find((r) => r.key === 'dev');
    const mainRow = railRows.find((r) => r.key === 'main');
    geo.set(p.id, {
      branches: rows.filter((r) => r.kind === 'b').map((r) => ({ y: r.y, color: branchColor(r.b.name, trunk) })),
      target: target?.y ?? null,
      targetColor: target?.color ?? null,
      dev: devRow?.y ?? null,
      main: mainRow?.y ?? null,
      pending: (t.ahead ?? 0) > 0,
      height,
    });

    const persons = p.persons;
    const label = (r) => {
      if (r.kind === 'b') {
        const b = r.b;
        const owner = persons[b.owner];
        const tip = [b.name, `${owner?.name ?? '?'} · ${ago(b.time)}`, `自己的提交 ${b.own} 个${b.behind ? `；${t.dev ?? t.main} 比它多 ${b.behind} 个` : ''}`, b.unpushed ? `本机还有 ${b.unpushed} 个提交没推送` : '', '点击在分支图里打开'].filter(Boolean).join('\n');
        return `<a class="ml b" style="height:${r.h}px;--c:${branchColor(b.name, trunk)}" href="${href(p.id, 'graph', { b: b.name })}" data-tip-c="${branchColor(b.name, trunk)}" data-tip="${esc(tip)}">${avatar(owner, 16)}<span class="nm">${esc(b.name)}</span>${b.pr ? prChip(b.pr, { mini: true }) : ''}${b.unpushed ? `<span class="warnc up">${icon.arrowUp(9)}${b.unpushed}</span>` : ''}</a>`;
      }
      if (r.kind === 'more') return `<a class="ml more" style="height:${r.h}px" href="${href(p.id, 'branches')}" data-tip="全部进行中的分支">+${r.n}</a>`;
      if (r.kind === 'none') return `<span class="ml none faint" style="height:${r.h}px">${icon.check(11)} 没有进行中的分支</span>`;
      const envs = p.envs.filter((e) => e.branch === r.name);
      return `<a class="ml rail" style="height:${r.h}px;--c:${r.color}" href="${linkHref(p.id, { view: 'graph', b: r.name })}" data-tip-c="${r.color}" data-tip="${esc(`${r.name}\n${r.key === 'main' ? '上线分支' : '集成分支'}${envs.length ? `\n环境：${envs.map((e) => e.name).join('、')}` : ''}\n点击看它的详情`)}"><i class="rb"></i><b>${esc(r.name)}</b></a>`;
    };

    // 轨道上的东西（按百分比放，不用量宽度）
    const on = [];
    const stationsFor = (r, from, to) => {
      const envs = p.envs.filter((e) => e.branch === r.name);
      envs.forEach((e, i) => {
        const x = envs.length === 1 ? (from + to) / 2 : from + ((to - from) * i) / (envs.length - 1);
        on.push(station(p, e, r, x));
      });
    };
    if (devRow) stationsFor(devRow, J1 + 0.08, J1 + 0.18);
    if (mainRow) stationsFor(mainRow, devRow ? 0.86 : 0.6, devRow ? 0.94 : 0.8);
    // 已进 dev、还没上线的分支：停在 dev 上的小点
    if (devRow && waiting.length) {
      const n = Math.min(waiting.length, 6);
      const x0 = J1 + 0.27;
      on.push(`<span class="wait" style="left:${x0 * 100}%;top:${devRow.y}px">${waiting.slice(0, n).map((b) => `<a class="wd" href="${href(p.id, 'graph', { b: b.name })}" style="--c:${branchColor(b.name, trunk)}" data-tip-c="${branchColor(b.name, trunk)}" data-tip="${esc(`${b.name}\n已进 ${t.dev}、还没进 ${t.main}（等上线）\n${persons[b.owner]?.name ?? ''} · ${ago(b.time)}`)}"></a>`).join('')}${waiting.length > n ? `<a class="wn" href="${href(p.id, 'branches', { f: 'pending' })}" data-tip="已进 ${esc(t.dev)}、等上线的分支">+${waiting.length - n}</a>` : ''}</span>`);
    }
    // dev → main 的连线上：待上线、没回合
    if (devRow && mainRow) {
      const mid = (devRow.y + mainRow.y) / 2;
      const a = t.ahead ?? 0;
      const bk = t.behind ?? 0;
      const who = (list) => (list ?? []).slice(0, 4).map((x) => `${persons[x.id]?.name ?? '?'} ${x.n}`).join('、');
      const wait = t.oldest ? Math.floor((Date.now() / 1000 - t.oldest) / DAY) : 0;
      const pend = a
        ? `<a class="gapb go${wait >= 7 ? ' old' : ''}" href="${linkHref(p.id, { view: 'graph', b: t.dev, t: 'ahead' })}" data-tip="${esc(`待上线：${a} 个提交在 ${t.dev}、还没进 ${t.main}${t.oldest ? `\n最早一个等了 ${ago(t.oldest).replace('前', '')}` : ''}${t.aheadPeople?.length ? `\n${who(t.aheadPeople)}` : ''}\n点击查看`)}">${icon.arrowDown(10)}${a}${wait ? `<em>${wait}天</em>` : ''}</a>`
        : `<span class="gapb ok" data-tip="${esc(`${t.main} 已包含 ${t.dev} 的全部提交`)}">${icon.check(10)}</span>`;
      const back = bk ? `<a class="gapb warn" href="${linkHref(p.id, { view: 'graph', b: t.main, t: 'behind' })}" data-tip="${esc(`没回合：${t.main} 上有 ${bk} 个提交不在 ${t.dev}，要合回 ${t.dev}${t.behindPeople?.length ? `\n${who(t.behindPeople)}` : ''}\n点击查看`)}">${icon.arrowUp(10)}${bk}</a>` : '';
      on.push(`<span class="gaps" style="left:calc(${J2 * 100}% + 12px);top:${mid}px">${pend}${back}</span>`);
    }
    return `<div class="pmap" data-map="${esc(p.id)}">
      <div class="mls">${rows.map(label).join('')}</div><i class="rz-map"></i>
      <div class="trk" style="height:${height}px"><svg class="msvg" height="${height}"></svg>${on.join('')}</div>
    </div>`;
  }

  function station(p, e, r, x) {
    const st = e.state === 'down' ? 'down' : !e.known ? 'unknown' : e.behind ? 'behind' : e.skip ? 'skip' : 'ok';
    const state = st === 'down' ? `连不上${e.detail ? `：${e.detail}` : ''}` : st === 'unknown' ? (e.probe ? `在线，但读不出运行的是哪个提交：${e.detail ?? '接口没有返回提交号'}` : '没填探测地址，不知道线上跑的是哪个提交') : st === 'behind' ? `落后 ${e.branch} ${e.behind} 个提交（${e.branch} 上有、它还没部署的）` : st === 'skip' ? `有 ${e.skip} 个提交没经过前一个环境` : `和 ${e.branch} 一致`;
    const via = e.via === 'manifest' ? '（版本号靠本机打包清单对到提交）' : e.via === 'tag' ? '（版本号靠标签对到提交）' : e.via === 'field' ? '（接口直接返回提交号）' : '';
    const run = e.known ? `\n运行 ${e.version ? '版本 ' + e.version + ' → ' : ''}${e.short} ${via}` : '';
    const mark = st === 'ok' ? icon.check(9) : st === 'behind' ? `${icon.arrowDown(9)}${e.behind}` : st === 'skip' || st === 'down' ? icon.alert(9) : '?';
    // 读不出提交 / 连不上的：点了直接去设置里测试探测地址；读得出的：看这个环境的详情
    const fix = st === 'unknown' || st === 'down';
    const go = fix ? linkHref(p.id, { view: 'settings' }) : e.id ? linkHref(p.id, { view: 'graph', env: e.id }) : linkHref(p.id, { view: 'graph', c: e.sha });
    return `<a class="stn ${st}" href="${go}" style="left:${x * 100}%;top:${r.y}px;--c:${r.color}" data-tip-c="${r.color}" data-tip="${esc(`环境「${e.name}」\n${state}${run}\n${fix ? '点击去设置里测试探测地址' : '点击看这个环境'}`)}"><i>${icon.server(9)}</i><span>${esc(e.name)}<em>${mark}</em></span></a>`;
  }

  /**
   * 错位瀑布流：卡片按顺序从左到右排，每张只占自己的高度，下一张接在上面那张的正下方（不再按行对齐留空）。
   * 做法：网格的行只有 2px 高，每张卡片按自己的实际高度占若干行。
   */
  const ROW = 2;
  const GAP = 16;
  function masonry() {
    const grid = root.querySelector('[data-pgrid]');
    if (!grid) return;
    for (const c of grid.children) {
      if (c.classList.contains('dragging')) continue;
      c.style.gridRowEnd = `span ${Math.ceil((c.getBoundingClientRect().height + GAP) / ROW)}`;
    }
  }

  /** 量出每张线路图的宽度，画轨道和汇入线。 */
  function paintMaps() {
    for (const box of root.querySelectorAll('[data-map]')) {
      const g = geo.get(box.dataset.map);
      const svg = box.querySelector('.msvg');
      if (!g || !svg) continue;
      const W = box.querySelector('.trk').clientWidth;
      if (!W) continue;
      svg.setAttribute('width', W);
      const r = 8;
      let out = '';
      const path = (d, color, w, extra = '') => (out += `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round"${extra}/>`);
      // 主线：main 贯穿到底；dev 到 J2 转下去汇入 main（有待上线的是虚线）
      if (g.main != null) path(`M0 ${g.main}H${W}`, MAIN, 5);
      if (g.dev != null) {
        const x2 = Math.round(W * J2);
        path(`M0 ${g.dev}H${x2 - r}`, DEV, 5);
        if (g.main != null) path(`M${x2 - r} ${g.dev}Q${x2} ${g.dev} ${x2} ${g.dev + r}V${g.main - r}Q${x2} ${g.main} ${x2 + r} ${g.main}`, DEV, 2.5, g.pending ? ' stroke-dasharray="3 4"' : ' opacity=".35"');
      }
      // 分支：从左边走到 J1，转下去（虚线 = 还没合进去）指向要汇入的主线；越靠上的越晚转，线不交叉
      const n = g.branches.length;
      g.branches.forEach((b, i) => {
        const x1 = Math.round(W * J1) + (n - 1 - i) * 8;
        path(`M6 ${b.y}H${x1 - r}Q${x1} ${b.y} ${x1} ${b.y + r}`, b.color, 2.5);
        if (g.target != null) path(`M${x1} ${b.y + r}V${g.target - 7}`, b.color, 2, ' stroke-dasharray="2 3"');
        out += `<circle cx="6" cy="${b.y}" r="3.5" fill="${b.color}"/>`;
        if (g.target != null) out += `<path d="M${x1 - 3} ${g.target - 9}L${x1} ${g.target - 5}L${x1 + 3} ${g.target - 9}" fill="none" stroke="${b.color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
      });
      svg.innerHTML = out;
    }
  }

  /* ---------- 决策：这个项目要处理的问题 ---------- */
  function decisions(p) {
    const sig = [...p.signals].sort((a, b) => LEVEL[a.level] - LEVEL[b.level]);
    const imp = sig.filter((s) => s.level !== 'info');
    const info = sig.filter((s) => s.level === 'info');
    if (!imp.length && !info.length) return '';
    const open = infoOpen.has(p.id);
    const row = (s) => `<a class="dec ${s.level}" href="${linkHref(p.id, s.link)}" data-tip="${esc(s.detail ?? '')}">${levelIcon(s.level, 13)}<span class="it">${esc(s.title)}</span>${icon.chevronRight(11)}</a>`;
    return `<div class="decs">
      ${imp.map(row).join('')}
      ${info.length ? `<button class="more" data-info="${esc(p.id)}" data-tip="提示">${open ? icon.chevronDown(11) : icon.chevronRight(11)}${icon.info(11)}<span>${info.length}</span></button>${open ? info.map(row).join('') : ''}` : ''}
    </div>`;
  }

  /* ================= 成员：跨项目合并同一个人 ================= */
  function people() {
    const by = new Map();
    for (const p of P()) {
      for (const u of p.people) {
        const k = u.name.toLowerCase();
        if (!by.has(k)) by.set(k, { name: u.name, avatar: u.avatar, last: 0, d7: 0, branches: [], where: [] });
        const x = by.get(k);
        x.avatar ??= u.avatar;
        x.d7 += u.d7;
        if (u.last > x.last) {
          x.last = u.last;
          x.home = { p, id: u.id };
        }
        for (const b of u.branches) x.branches.push({ ...b, p });
        if (u.d7 || u.branches.length) x.where.push(p);
      }
    }
    const list = [...by.values()].filter((x) => x.d7 || x.branches.length).sort((a, b) => b.last - a.last);
    return `<section class="mod">
      <h2><span>成员</span><span class="tag">Members</span><span class="n">${list.length}</span></h2>
      ${list.map((x) => `<a class="urow" href="${href(x.home.p.id, 'people', {}, x.home.id)}">
        ${avatar(x, 28)}
        <span class="un"><b>${esc(x.name)}</b><span class="muted">${ago(x.last)}</span></span>
        <span class="ub">${x.branches.sort((a, b) => b.time - a.time).slice(0, 2).map((b) => `<span class="bpill" style="--c:${branchColor(b.name)}" data-tip-c="${branchColor(b.name)}" data-tip="${esc(`${b.name}\n项目：${b.p.name}\n提交：自己的 ${b.own} 个 · ${ago(b.time)}`)}"><i></i><span data-mid="${esc(b.name)}">${esc(b.name)}</span></span>`).join('')}${x.branches.length > 2 ? `<span class="muted" data-tip="${esc(x.branches.slice(2).map((b) => b.name).join('、'))}">+${x.branches.length - 2}</span>` : ''}</span>
        <span class="uc" data-tip="近 7 天的提交">${icon.commit(11)}${x.d7}</span>
      </a>`).join('') || '<div class="quiet">最近没有人提交</div>'}
    </section>`;
  }

  /* ================= 本机：按项目分组，一个项目一行（几条分支没推送、几个工作区有改动），点开看明细 ================= */
  function local() {
    const groups = P().filter((p) => p.unpushed.length || p.dirty.length);
    const row = (p) => {
      const open = localOpen.has(p.id);
      const commits = p.unpushed.reduce((n, b) => n + b.unpushed, 0);
      const files = p.dirty.reduce((n, c) => n + c.total, 0);
      const head = `<button class="lgrp${open ? ' on' : ''}" data-local="${esc(p.id)}">${open ? icon.chevronDown(11) : icon.chevronRight(11)}${projTag(p)}<span class="grow"></span>
        ${p.unpushed.length ? `<span class="warn" data-tip="${esc(`${p.unpushed.length} 条分支、${commits} 个提交没推送`)}">${icon.arrowUp(10)}${p.unpushed.length}</span>` : ''}
        ${p.dirty.length ? `<span class="muted" data-tip="${esc(`${p.dirty.length} 个工作区、${files} 个文件改了没提交`)}">${icon.pencil(10)}${p.dirty.length}</span>` : ''}</button>`;
      if (!open) return head;
      return `${head}<div class="lsub">
        ${p.unpushed.map((b) => `<a class="lrow2" href="${href(p.id, 'graph', { b: b.name })}" data-tip="${esc(`${b.name}\n本机有 ${b.unpushed} 个提交没推送`)}"><span class="bpill" style="--c:${branchColor(b.name, p.trunk)}"><i></i><span data-mid="${esc(b.name)}">${esc(b.name)}</span></span><span class="warn">${icon.arrowUp(10)}${b.unpushed}</span></a>`).join('')}
        ${p.dirty.map((c) => `<a class="lrow2" href="${href(p.id)}" data-tip="${esc(`${c.name}${c.branch ? `（${c.branch}）` : ''}：${c.total} 个文件改了没提交`)}"><span class="muted">${icon.desktop(11)} ${esc(c.name)}</span><span class="muted">${icon.pencil(10)}${c.total}</span></a>`).join('')}
      </div>`;
    };
    return `<section class="mod">
      <h2><span>本机</span><span class="tag">Local</span><span class="n">${groups.length}</span></h2>
      ${groups.map(row).join('') || `<div class="quiet">${levelIcon('good', 14)} 都推送了，也没有没提交的改动</div>`}
    </section>`;
  }

  function draw() {
    if (drag?.on) return; // 正在拖卡片：别重画，松手后再画
    const ready = P();
    const hot = ready.reduce((n, p) => n + p.signals.filter((s) => s.level !== 'info').length, 0);
    const branches = ready.reduce((n, p) => n + (p.lanes?.active.length ?? 0), 0);
    const ahead = ready.reduce((n, p) => n + (p.trunk?.ahead ?? 0), 0);
    const failed = data.projects.filter((p) => !p.ready && p.sync?.status === 'error').length;
    geo.clear();
    root.innerHTML = `<div class="ptitle"><h1>看板</h1><p>${data.projects.length} 个项目 · ${branches} 条分支在做 · ${ahead} 个提交待上线 · ${hot + failed ? `${hot + failed} 件需要处理` : '都正常'}</p></div>
      <div class="bcol">
        <div class="pgrid" data-pgrid>${data.projects.map(projectBlock).join('') || `<section class="mod"><div class="quiet pad">还没有项目</div></section>`}</div>
        <button class="addpj" data-add-project>${icon.plus(13)}<span>添加项目</span></button>
      </div>
      <div class="bcol">${local()}${people()}</div>
      <i class="rz-board"></i>`;
    // 可拖：左右两栏的分界（右栏宽度）、线路图名字那一列的宽度（所有项目共用一个宽度）
    resizer(root.querySelector('.rz-board'), { target: root, prop: '--bw', key: 'board-right', min: 260, max: 640, dir: -1, def: 380, onChange: paintMaps });
    for (const h of root.querySelectorAll('.rz-map')) resizer(h, { target: root, prop: '--mlw', key: 'board-map-labels', min: 110, max: 420, dir: 1, def: 150, onChange: paintMaps });
    paintMaps();
    masonry();
  }

  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-add-project]')) return addProject?.();
    const f = e.target.closest('[data-fold]');
    if (f) {
      const id = f.dataset.fold;
      fold.has(id) ? fold.delete(id) : fold.add(id);
      saveFold(fold);
      return draw();
    }
    const inf = e.target.closest('[data-info]');
    if (inf) {
      const id = inf.dataset.info;
      infoOpen.has(id) ? infoOpen.delete(id) : infoOpen.add(id);
      return draw();
    }
    const lg = e.target.closest('[data-local]');
    if (lg) {
      const id = lg.dataset.local;
      localOpen.has(id) ? localOpen.delete(id) : localOpen.add(id);
      draw();
    }
  });

  /* ---------- 拖动项目卡片换位置：按住卡片标题栏的空白处拖；顺序和左侧栏是同一份（写回 config.json） ---------- */
  let drag = null; // { card, ph, x0, y0, dx, dy, pid, on }
  let suppressClick = 0;
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag) return;
    const hd = e.target.closest('.pblk .phd');
    if (!hd || e.target.closest('a, button, input')) return;
    drag = { card: hd.closest('.pblk'), x0: e.clientX, y0: e.clientY, pid: e.pointerId, on: false };
  });
  const onMove = (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    if (!drag.on) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
      beginDrag();
    }
    e.preventDefault();
    moveDrag(e.clientX, e.clientY);
  };
  const onUp = (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    if (drag.on) endDrag(true);
    else drag = null;
  };
  const onKey = (e) => e.key === 'Escape' && drag?.on && endDrag(false);
  const onClick = (e) => {
    if (Date.now() < suppressClick) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('keydown', onKey);
  window.addEventListener('click', onClick, true);

  function beginDrag() {
    const { card } = drag;
    const r = card.getBoundingClientRect();
    drag.on = true;
    drag.dx = drag.x0 - r.left;
    drag.dy = drag.y0 - r.top;
    const ph = document.createElement('div');
    ph.className = 'pblk-ph';
    ph.style.height = r.height + 'px';
    card.before(ph);
    masonry();
    drag.ph = ph;
    card.classList.add('dragging');
    Object.assign(card.style, { width: r.width + 'px', left: r.left + 'px', top: r.top + 'px' });
    document.body.classList.add('dragging-card');
  }
  function moveDrag(x, y) {
    const { card, ph } = drag;
    card.style.left = x - drag.dx + 'px';
    card.style.top = y - drag.dy + 'px';
    // 鼠标落在哪张卡片（或空位）上：在空位上就不动；在别的卡片上，同一行按左右半边、否则按上下决定放它前面还是后面
    let best = null;
    let bd = Infinity;
    for (const c of root.querySelectorAll('[data-pgrid] > .pblk:not(.dragging), [data-pgrid] > .pblk-ph')) {
      const r = c.getBoundingClientRect();
      const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      const d = inside ? -1 : Math.hypot(x - Math.max(r.left, Math.min(x, r.right)), y - Math.max(r.top, Math.min(y, r.bottom)));
      if (d < bd) {
        bd = d;
        best = { c, r };
      }
    }
    if (!best || best.c === ph) return;
    const { c, r } = best;
    const before = y >= r.top && y <= r.bottom ? x < r.left + r.width / 2 : y < r.top;
    if (before ? c.previousElementSibling !== ph : c.nextElementSibling !== ph) {
      before ? c.before(ph) : c.after(ph);
      masonry();
    }
    // 拖到窗口边上自动滚
    const sc = root.closest('.page');
    if (sc) {
      const sr = sc.getBoundingClientRect();
      if (y < sr.top + 40) sc.scrollTop -= 12;
      else if (y > sr.bottom - 40) sc.scrollTop += 12;
    }
  }
  async function endDrag(ok) {
    const { card, ph } = drag;
    card.classList.remove('dragging');
    card.removeAttribute('style');
    document.body.classList.remove('dragging-card');
    if (ok) ph.replaceWith(card);
    else ph.remove();
    drag = null;
    suppressClick = Date.now() + 250;
    if (!ok) return draw();
    const ids = [...root.querySelectorAll('[data-pgrid] > .pblk[data-p]')].map((c) => c.dataset.p);
    const byId = new Map(data.projects.map((p) => [p.id, p]));
    if (ids.join() === data.projects.map((p) => p.id).join()) return draw();
    data = { ...data, projects: ids.map((id) => byId.get(id)).filter(Boolean) };
    draw();
    try {
      await request('/api/projects/order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order: ids.map((id) => ({ id, group: byId.get(id)?.group ?? null })) }) });
    } catch (e) {
      toast('顺序没存上：' + e.message);
      load();
    }
  }

  const ro = new ResizeObserver(() => {
    if (!data) return;
    paintMaps();
    masonry();
  });
  ro.observe(root);
  load();
  const tick = setInterval(() => data && draw(), 60000);
  return {
    refresh() {
      clearTimeout(timer);
      timer = setTimeout(load, 800);
    },
    theme() {
      paintMaps();
    },
    unmount() {
      clearTimeout(timer);
      clearInterval(tick);
      ro.disconnect();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', onClick, true);
    },
  };
}
