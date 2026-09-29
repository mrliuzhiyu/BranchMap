// 分支图：一个项目的全部，一层一层往下看。
//   左：main / dev 两条主线（带「生产」「测试」这类环境标签，可以加）+ 按人列出的分支，颜色和图上一致
//   中：提交图。main、dev 是两条贯穿全图的粗轨道；每条分支有自己的颜色；合并完的历史是灰色
//   右：第二层——点分支：它是谁的、走到哪了、它自己的提交；第三层——点提交：走到哪了、改了哪些文件（可返回分支）
// 能用图形表达的就不写字；解释都放在悬停提示里。
import { esc, icon, avatar, ago, when, fullStamp, toast, copyText, closePop, debounce, lineStat, filePath } from '../lib/util.js';
import { layout, segPath, TRUNKS } from '../lib/layout.js';
import { openChanges } from '../lib/changes.js';
import { commitChangesLoader } from '../lib/commitview.js';
import { has } from '../lib/model.js';
import { MAIN, DEV, HIST, branchColor } from '../lib/colors.js';

const RH = 30;
const LW = 16;
const PAD = 14;
const MAX_LANES = 16;
const OVERSCAN = 12;
const RECENT_MERGED = 7 * 86400;

export function mount(el, ctx) {
  const { store } = ctx;
  let M = store.model;
  let O = ctx.overview;
  const S = {
    sel: ctx.params.get('c') || null,
    branch: ctx.params.get('b') || null,
    who: ctx.params.has('who') ? Number(ctx.params.get('who')) : null,
    q: ctx.params.get('q') || '',
    fp: ctx.params.get('fp') === '1',
  };
  let V = null;
  let C = null;
  let selRow = -1;
  let painted = { first: -1, last: -1 };
  let detailToken = 0;

  el.innerHTML = `<div class="ws">
    <aside class="lcol" data-l></aside>
    <section class="gcol">
      <div class="gbar" data-bar></div>
      <div class="glist" tabindex="0"><div class="gbody"></div></div>
    </section>
    <aside class="dcol" data-d hidden></aside>
  </div>`;
  const L = el.querySelector('[data-l]');
  const bar = el.querySelector('[data-bar]');
  const list = el.querySelector('.glist');
  const body = el.querySelector('.gbody');
  const D = el.querySelector('[data-d]');

  /* ================= 数据：主线、每条分支的颜色、每个提交归谁 ================= */
  function prepare() {
    M = store.model;
    O = ctx.overview;
    const mainName = M.trunk.prod;
    const devName = M.trunk.dev;
    const mainTip = mainName ? M.branches.get(mainName)?.tip ?? -1 : -1;
    const devTip = devName ? M.branches.get(devName)?.tip ?? -1 : -1;
    const now = Date.now() / 1000;
    const rows = (O.branches ?? []).filter((b) => M.branches.has(b.name));
    // 列出来的分支：还在做的 + 最近 7 天合进去的；停滞的折叠
    const show = rows.filter((b) => b.status === 'active' || ((b.status === 'merged' || b.status === 'released') && now - b.time < RECENT_MERGED));
    const stale = rows.filter((b) => b.status === 'stale');
    const colorOf = new Map([['main', MAIN], ['dev', DEV], ['hist', HIST], ['wip', 'var(--muted)']]);
    for (const b of [...show, ...stale]) colorOf.set('b:' + b.name, branchColor(b.name));

    // 每个提交归谁：main 第一父链 → main；dev 第一父链 → dev；没合进主线的分支提交 → 那条分支；其余是合并完的历史
    const key = new Array(M.N).fill('hist');
    const mainChain = new Set();
    for (let c = mainTip; c !== undefined && c >= 0; c = M.P[c][0]) mainChain.add(c);
    for (let c = devTip; c !== undefined && c >= 0 && !mainChain.has(c); c = M.P[c][0]) key[c] = 'dev';
    for (const c of mainChain) key[c] = 'main';
    const trunkSet = M.union([mainTip, devTip].filter((x) => x >= 0));
    const owned = new Map();
    for (const b of [...show, ...stale].sort((x, y) => y.time - x.time)) {
      const mine = [];
      const st = [M.branches.get(b.name).tip];
      while (st.length) {
        const c = st.pop();
        if (c < 0 || has(trunkSet, c) || key[c] !== 'hist') continue;
        key[c] = 'b:' + b.name;
        mine.push(c);
        for (const p of M.P[c]) st.push(p);
      }
      owned.set(b.name, mine);
    }

    // 环境标签：挂在它运行的提交上（没探测到的挂在分支最新提交上，标成假定）
    const envs = (M.raw.envs ?? []).map((e) => ({ ...e, c: e.commit ? M.byHash.get(e.commit) ?? -1 : -1 }));
    const envAt = new Map();
    for (const e of envs) {
      if (e.c < 0) continue;
      if (!envAt.has(e.c)) envAt.set(e.c, []);
      envAt.get(e.c).push(e);
    }
    C = { mainName, devName, mainTip, devTip, key, colorOf, show, stale, owned, envs, envAt, trunkSet };
  }
  const colorFor = (k) => C.colorOf.get(k) ?? 'var(--hist)';
  const keyOfBranch = (name) => (name === C.mainName ? 'main' : name === C.devName ? 'dev' : 'b:' + name);
  const railOf = (e) => (e.branch === C.mainName ? 'main' : e.branch === C.devName ? 'dev' : null);

  /** 走到哪了：dev → 测试 → main → 生产（有几站画几个点） */
  function stops() {
    const out = [];
    const add = (name, k, tip) => tip >= 0 && out.push({ name, k, tip });
    add(C.devName, 'dev', C.devTip);
    for (const e of C.envs.filter((x) => x.branch === C.devName && x.c >= 0 && !x.assumed)) add(e.name, 'dev', e.c);
    add(C.mainName, 'main', C.mainTip);
    for (const e of C.envs.filter((x) => x.branch === C.mainName && x.c >= 0 && !x.assumed)) add(e.name, 'main', e.c);
    return out;
  }
  function journey(c) {
    const st = stops();
    return `<span class="jy" data-tip="${esc(st.map((s) => `${M.isAncestor(c, s.tip) ? '●' : '○'} ${s.name}`).join('\n'))}">${st.map((s) => `<i class="${M.isAncestor(c, s.tip) ? 'on' : ''}" style="--c:${colorFor(s.k)}"></i>`).join('')}</span>`;
  }
  function stepsHtml(c) {
    const st = stops();
    if (!st.length) return '';
    return `<div class="steps">${st.map((s) => {
      const on = M.isAncestor(c, s.tip);
      return `<div class="step${on ? ' on' : ''}" style="--c:${colorFor(s.k)}" data-tip="${esc(`${s.name}：${on ? '已包含' : '还没有'}`)}"><i></i><span>${esc(s.name)}</span></div>`;
    }).join('<b class="stepl"></b>')}</div>`;
  }

  function envPill(e, k, editable = false) {
    const color = colorFor(k ?? railOf(e) ?? 'hist');
    const tip = [
      e.assumed ? (e.probe ? `${e.name}：读不出运行的版本，暂按 ${e.branch} 最新提交显示` : `${e.name}：没填探测地址，按 ${e.branch} 最新提交显示`) : `${e.name}正在运行这个提交${e.version ? `（版本 ${e.version}）` : ''}`,
      e.assumed && e.detail ? e.detail : '',
      e.probe ? `探测：${e.probe}` : '',
      editable ? '点击修改' : '',
    ].filter(Boolean).join('\n');
    return `<span class="env${e.assumed ? ' assumed' : ''}${e.state === 'down' ? ' down' : ''}" style="--c:${color}" ${editable ? `data-edit-label="${esc(e.id)}"` : ''} data-tip="${esc(tip)}">${esc(e.name)}</span>`;
  }

  /* ================= 左栏：主线 + 按人的分支 ================= */
  function drawLeft() {
    const persons = O.persons;
    const localBy = new Map((O.local?.branches ?? []).map((b) => [b.name, b]));
    const loc = (lb) => `${lb?.unpushed > 0 ? `<span class="loc" data-tip="${esc(`本机有 ${lb.unpushed} 个提交没推送`)}">${icon.desktop(10)}${icon.arrowUp(10)}${lb.unpushed}</span>` : ''}${lb?.behind > 0 ? `<span class="loc dim" data-tip="${esc(`本机落后云端 ${lb.behind} 个提交（没拉取）`)}">${icon.desktop(10)}${icon.arrowDown(10)}${lb.behind}</span>` : ''}`;

    const rail = (name, k, tip) => {
      if (!name || tip < 0) return '';
      let gap = '';
      if (k === 'dev' && C.mainTip >= 0) {
        const n = M.countDiff(M.anc(C.devTip), M.anc(C.mainTip));
        if (n) gap = `<span class="gap" data-tip="${esc(`${n} 个提交在 ${name}、还没进 ${C.mainName}`)}">${icon.arrowRight(10)}${n}</span>`;
      }
      return `<div class="rail-row${S.branch === name ? ' on' : ''}" data-branch="${esc(name)}" style="--c:${colorFor(k)}">
        <i class="rbar"></i><span class="rname">${esc(name)}</span>
        ${C.envs.filter((e) => e.branch === name).map((e) => envPill(e, k, true)).join('')}
        <button class="add" data-add-label="${esc(name)}" data-tip="加环境标签">${icon.tag(12)}</button>
        <span class="grow"></span>${loc(localBy.get(name))}${gap}
      </div>`;
    };
    const branchRow = (b) => {
      const tip = M.branches.get(b.name).tip;
      const merged = b.status === 'merged' || b.status === 'released';
      return `<div class="br-row${S.branch === b.name ? ' on' : ''}${merged ? ' merged' : ''}" data-branch="${esc(b.name)}" style="--c:${colorFor('b:' + b.name)}" data-tip="${esc(`${b.name}\n${ago(b.time)}${b.pr ? `\nPR #${b.pr.n} ${b.pr.title ?? ''}` : ''}`)}">
        <i class="dot"></i><span class="bname">${esc(b.name)}</span>${loc(localBy.get(b.name))}
        ${merged ? journey(tip) : `<span class="own" data-tip="自己的提交">+${b.own}</span>`}
      </div>`;
    };
    const byPerson = new Map();
    for (const b of C.show) {
      if (!byPerson.has(b.owner)) byPerson.set(b.owner, []);
      byPerson.get(b.owner).push(b);
    }
    const groups = [...byPerson].sort((x, y) => Math.max(...y[1].map((b) => b.time)) - Math.max(...x[1].map((b) => b.time)));
    const staleOpen = L.dataset.stale === '1';
    L.innerHTML = `
      <div class="rails">${rail(C.mainName, 'main', C.mainTip)}${rail(C.devName, 'dev', C.devTip)}</div>
      <div class="people">
        ${groups.map(([pid, bs]) => {
          const p = persons[pid];
          return `<div class="pgroup">
            <button class="p-row${S.who === pid ? ' on' : ''}" data-who="${pid}" data-tip="${esc(`只看 ${p?.name ?? ''} 的提交`)}">${avatar(p, 18)}<span>${esc(p?.name ?? '?')}</span></button>
            ${bs.sort((x, y) => y.time - x.time).map(branchRow).join('')}
          </div>`;
        }).join('') || `<div class="quiet">${icon.check(12)} 没有进行中的分支</div>`}
        ${C.stale.length ? `<button class="more" data-stale-toggle data-tip="超过 30 天没动、也没合进主线">${staleOpen ? icon.chevronDown(11) : icon.chevronRight(11)}${icon.clock(11)}<span>${C.stale.length}</span></button>${staleOpen ? C.stale.map(branchRow).join('') : ''}` : ''}
      </div>`;
  }

  /* ================= 中间：提交图 ================= */
  function drawBar() {
    const chip = S.branch
      ? `<i class="dot" style="background:${colorFor(keyOfBranch(S.branch))}"></i>${esc(S.branch)}`
      : S.who != null ? `${avatar(O.persons[S.who], 16)}${esc(O.persons[S.who]?.name ?? '')}` : '';
    bar.innerHTML = `
      <label class="gsearch" data-tip="搜提交说明、哈希、作者（回车跳到下一个）">${icon.search(13)}<input data-q value="${esc(S.q)}" autocomplete="off"><span class="count" data-qcount></span></label>
      <button class="icon-btn" data-fp aria-pressed="${S.fp}" data-tip="只看主线">${icon.commit(15)}</button>
      ${chip ? `<button class="chipx" data-clear data-tip="取消筛选">${chip}${icon.close(11)}</button>` : ''}
      <span class="grow"></span>
      <span class="legend">${C.mainName ? `<i style="background:${colorFor('main')}"></i>${esc(C.mainName)}` : ''}${C.devName ? `<i style="background:${colorFor('dev')}"></i>${esc(C.devName)}` : ''}<i class="h"></i><span data-tip="已经合并完的历史">历史</span></span>`;
  }

  function wipNodes() {
    const out = [];
    for (const w of store.wtState ?? []) {
      if (w.temp || !w.total) continue;
      const c = M.worktrees.find((x) => x.path === w.path)?.c ?? -1;
      if (c >= 0) out.push({ id: M.N + out.length, c, w });
    }
    return out;
  }

  function compute() {
    let visible = null;
    if (S.fp) {
      visible = new Uint32Array(M.W);
      for (const t of [C.mainTip, C.devTip]) for (let c = t; c !== undefined && c >= 0 && !has(visible, c); c = M.P[c][0]) visible[c >>> 5] |= 1 << (c & 31);
    }
    const wips = S.fp ? [] : wipNodes();
    const wipAt = new Map();
    for (const x of wips) {
      if (!wipAt.has(x.c)) wipAt.set(x.c, []);
      wipAt.get(x.c).push(x.id);
    }
    const order = [];
    for (let i = 0; i < M.N; i++) {
      if (visible && !has(visible, i)) continue;
      const w = wipAt.get(i);
      if (w) order.push(...w);
      order.push(i);
    }
    const rowOf = new Map(order.map((id, r) => [id, r]));
    const pin = new Map();
    for (let c = C.mainTip; c !== undefined && c >= 0; c = M.P[c][0]) if (rowOf.has(c)) pin.set(c, 0);
    for (let c = C.devTip; c !== undefined && c >= 0 && !pin.has(c); c = M.P[c][0]) if (rowOf.has(c)) pin.set(c, 1);
    const rails = new Map();
    if (rowOf.has(C.mainTip)) rails.set(0, { start: rowOf.get(C.mainTip), key: 'main' });
    if (rowOf.has(C.devTip)) rails.set(1, { start: rowOf.get(C.devTip), key: 'dev' });
    const wipBy = new Map(wips.map((x) => [x.id, x]));
    const keyOf = (id) => (id >= M.N ? 'wip' : C.key[id]);
    const Lr = layout(order, (id) => (id >= M.N ? [wipBy.get(id).c] : M.P[id]), { pin, rails, keyOf });
    let focusKey = null;
    if (S.branch) focusKey = keyOfBranch(S.branch);
    const focus = focusKey ? (id) => id < M.N && C.key[id] === focusKey : S.who != null ? (id) => id < M.N && M.a[id] === S.who : null;
    V = { order, rows: Lr.rows, width: Math.min(Math.max(Lr.width, 2), MAX_LANES), wips: wipBy, rowOf, focus, focusKey };
    V.gw = PAD * 2 + (V.width - 1) * LW;
    list.style.setProperty('--gw', V.gw + 'px');
    body.style.height = order.length * RH + 'px';
    computeMatches();
    painted = { first: -1, last: -1 };
  }

  function computeMatches() {
    const q = S.q.trim().toLowerCase();
    V.match = null;
    V.matchSet = null;
    if (q) {
      const pids = new Set(M.people.filter((p) => p.name.toLowerCase().includes(q) || p.names.some((n) => n.toLowerCase().includes(q))).map((p) => p.id));
      V.match = [];
      V.order.forEach((id, r) => {
        if (id < M.N && (M.s[id].toLowerCase().includes(q) || M.h[id].startsWith(q) || pids.has(M.a[id]))) V.match.push(r);
      });
      V.matchSet = new Set(V.match);
    }
    const qc = bar.querySelector('[data-qcount]');
    if (qc) qc.textContent = V.match ? `${V.match.length ? (V.match.indexOf(selRow) + 1 || '–') + '/' : ''}${V.match.length}` : '';
  }

  const lx = (l) => PAD + l * LW;
  const isRail = (s) => s[0] === s[2] && s[0] <= 1 && TRUNKS.has(s[4]);

  function labels(id) {
    const out = [];
    for (const e of C.envAt.get(id) ?? []) out.push(envPill(e, railOf(e)));
    for (const r of M.refsAt.get(id) ?? []) {
      if (r.kind !== 'R') continue;
      const n = r.short ?? r.name;
      const k = n === C.mainName ? 'main' : n === C.devName ? 'dev' : C.colorOf.has('b:' + n) ? 'b:' + n : null;
      if (!k) continue;
      const here = M.worktrees.filter((w) => w.branch === n);
      out.push(`<span class="bn${TRUNKS.has(k) ? ' trunk' : ''}" style="--c:${colorFor(k)}" data-tip="${esc(`${n}${here.length ? '\n本机检出：' + here.map((w) => w.path).join('，') : ''}`)}">${icon.cloud(11)}${esc(n)}${here.length ? icon.desktop(10) : ''}</span>`);
    }
    return out.join('');
  }

  function rowHtml(r) {
    const id = V.order[r];
    const style = `top:${r * RH}px;height:${RH}px`;
    if (id >= M.N) {
      const x = V.wips.get(id);
      return `<div class="gr wip${selRow === r ? ' sel' : ''}" data-r="${r}" style="${style}"><div class="gg"></div><div class="gm"><span class="wipt" data-tip="${esc(x.w.path)}">${icon.desktop(11)}${esc(x.w.path.split('\\').pop())}</span><span class="gs">${icon.pencil(11)} ${x.w.total}</span></div><div class="ga"></div><div class="gt"></div></div>`;
    }
    const p = M.person(M.a[id]);
    const dim = V.focus && !V.focus(id);
    const cls = `gr${selRow === r ? ' sel' : ''}${dim ? ' dim' : ''}${V.matchSet?.has(r) ? ' match' : ''}${M.P[id].length > 1 ? ' merge' : ''}${TRUNKS.has(C.key[id]) ? ' trunk' : ''}`;
    return `<div class="${cls}" data-r="${r}" style="${style}"><div class="gg"></div><div class="gm">${labels(id)}<span class="gs">${esc(M.s[id])}</span></div><div class="ga" data-tip="${esc(p?.name ?? '')}">${avatar(p, 18)}</div><div class="gt" data-tip="${fullStamp(M.t[id])}">${when(M.t[id])}</div></div>`;
  }

  function svgHtml(first, last) {
    const paths = new Map();
    const add = (k, w, d) => {
      const g = k + '|' + w;
      paths.set(g, (paths.get(g) ?? '') + d);
    };
    const nodes = [];
    for (let r = first; r < last; r++) {
      const row = V.rows[r];
      const y = (r - first) * RH;
      for (const s of row.segs) {
        if (s[0] >= MAX_LANES && s[2] >= MAX_LANES) continue;
        add(s[4], isRail(s) ? 4 : 2, segPath(lx(Math.min(s[0], MAX_LANES - 1)), y + s[1] * RH, lx(Math.min(s[2], MAX_LANES - 1)), y + s[3] * RH));
      }
      const id = V.order[r];
      const cx = lx(Math.min(row.lane, MAX_LANES - 1));
      const cy = y + RH / 2;
      if (id >= M.N) {
        nodes.push(`<circle cx="${cx}" cy="${cy}" r="5" fill="var(--surface)" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="2 2"/>`);
        continue;
      }
      const k = C.key[id];
      const dim = V.focus && !V.focus(id) ? ' opacity=".22"' : '';
      const rr = TRUNKS.has(k) ? 5.5 : k === 'hist' ? 3.5 : 4.5;
      if (M.P[id].length > 1) nodes.push(`<circle cx="${cx}" cy="${cy}" r="${rr - 0.5}" fill="var(--surface)" stroke="${colorFor(k)}" stroke-width="2.5"${dim}/>`);
      else nodes.push(`<circle cx="${cx}" cy="${cy}" r="${rr}" fill="${colorFor(k)}" stroke="var(--surface)" stroke-width="2"${dim}/>`);
      if (r === selRow) nodes.push(`<circle cx="${cx}" cy="${cy}" r="${rr + 4}" fill="none" stroke="var(--text)" stroke-width="1.5"/>`);
    }
    let out = '';
    // 细线在下、粗轨道在上；选中分支时别的线淡下去
    for (const [g, d] of [...paths].sort((a, b) => Number(a[0].split('|')[1]) - Number(b[0].split('|')[1]))) {
      const [k, w] = g.split('|');
      const dim = V.focusKey && k !== V.focusKey ? ' opacity=".22"' : '';
      out += `<path d="${d}" fill="none" stroke="${colorFor(k)}" stroke-width="${w}" stroke-linecap="round"${k === 'wip' ? ' stroke-dasharray="3 4"' : ''}${dim}/>`;
    }
    return `<svg class="gsvg" width="${V.gw}" height="${(last - first) * RH}" style="top:${first * RH}px">${out}${nodes.join('')}</svg>`;
  }

  function paint(force = false) {
    const top = list.scrollTop;
    const first = Math.max(0, Math.floor(top / RH) - OVERSCAN);
    const last = Math.min(V.order.length, Math.ceil((top + list.clientHeight) / RH) + OVERSCAN);
    if (!force && first === painted.first && last === painted.last) return;
    painted = { first, last };
    let html = svgHtml(first, last);
    for (let r = first; r < last; r++) html += rowHtml(r);
    body.innerHTML = html;
  }
  let raf = 0;
  list.addEventListener('scroll', () => {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); });
  });
  const ro = new ResizeObserver(() => paint(true));
  ro.observe(list);

  function scrollToRow(r, center = false) {
    const y = r * RH;
    const h = list.clientHeight;
    if (center) list.scrollTop = Math.max(0, y - h / 2 + RH / 2);
    else if (y < list.scrollTop) list.scrollTop = y;
    else if (y + RH > list.scrollTop + h) list.scrollTop = y + RH - h;
  }

  /* ================= 右边：第二层分支、第三层提交 ================= */
  function closeDetail() {
    detailToken++;
    D.hidden = true;
    selRow = -1;
    S.sel = null;
    ctx.setParams({ c: null });
    paint(true);
  }
  function dtop(back) {
    const b = back ? `<button class="back" data-back data-tip="回到分支">${icon.arrowLeft(13)}<i class="dot" style="background:${colorFor(keyOfBranch(back))}"></i>${esc(back)}</button>` : '';
    return `<div class="dtop">${b}<span class="grow"></span><button class="icon-btn" data-close data-tip="关闭 (Esc)">${icon.close(14)}</button></div>`;
  }

  function showBranch(name) {
    detailToken++;
    const k = keyOfBranch(name);
    const tip = M.branches.get(name)?.tip ?? -1;
    if (tip < 0) return closeDetail();
    const b = O.branches.find((x) => x.name === name);
    const owner = b ? O.persons[b.owner] : M.person(M.a[tip]);
    let commits;
    if (TRUNKS.has(k)) {
      commits = [];
      for (let c = tip; c !== undefined && c >= 0 && commits.length < 40; c = M.P[c][0]) commits.push(c);
    } else commits = [...(C.owned.get(name) ?? [])].sort((x, y) => x - y).slice(0, 80);
    D.hidden = false;
    D.innerHTML = `${dtop(null)}
      <div class="bhead" style="--c:${colorFor(k)}"><i class="${TRUNKS.has(k) ? 'rbar' : 'dot'}"></i><h3>${esc(name)}</h3>${C.envs.filter((e) => e.branch === name).map((e) => envPill(e, TRUNKS.has(k) ? k : null)).join('')}
        ${M.raw.slug ? `<a class="icon-btn" href="https://github.com/${esc(M.raw.slug)}/tree/${encodeURIComponent(name)}" target="_blank" rel="noreferrer" data-tip="在 GitHub 打开">${icon.ext(12)}</a>` : ''}</div>
      <div class="dmeta">${avatar(owner, 20)}<span>${esc(owner?.name ?? '')}</span><span class="muted" data-tip="${fullStamp(M.ct[tip])}">${ago(M.ct[tip])}</span>${b ? `<span class="muted" data-tip="${esc(`自己的提交 ${b.own} 个；${C.devName ?? C.mainName ?? '主线'} 比它多 ${b.behind ?? 0} 个`)}">${icon.arrowUp(10)}${b.own} ${icon.arrowDown(10)}${b.behind ?? 0}</span>` : ''}</div>
      ${stepsHtml(tip)}
      ${b?.pr ? `<a class="dpr" href="${esc(b.pr.url)}" target="_blank" rel="noreferrer">${icon.pr(12)}#${b.pr.n} ${esc(b.pr.title ?? '')}</a>` : ''}
      <div class="clist">${commits.map((c) => `<button class="crow" data-open="${c}">${journey(c)}<span class="s">${esc(M.s[c])}</span>${avatar(M.person(M.a[c]), 16)}<span class="t">${when(M.t[c])}</span></button>`).join('') || `<div class="quiet">${icon.check(12)} 已经全部合进主线</div>`}</div>`;
  }

  function showCommit(c, back = null) {
    const my = ++detailToken;
    const p = M.person(M.a[c]);
    const pr = M.prByMerge?.get(M.h[c]);
    D.hidden = false;
    D.innerHTML = `${dtop(back)}
      <h3 class="dsub">${esc(M.s[c])}</h3>
      <pre class="dbody" data-body hidden></pre>
      <div class="dmeta">${avatar(p, 20)}<span>${esc(p?.name ?? '')}</span><span class="muted" data-tip="${fullStamp(M.t[c])}">${ago(M.t[c])}</span><button class="sha" data-copy="${M.h[c]}" data-tip="复制完整哈希">${M.short(c)}</button>${M.raw.slug ? `<a class="icon-btn" href="https://github.com/${esc(M.raw.slug)}/commit/${M.h[c]}" target="_blank" rel="noreferrer" data-tip="在 GitHub 打开">${icon.ext(12)}</a>` : ''}</div>
      ${stepsHtml(c)}
      ${pr ? `<a class="dpr" href="${esc(pr.url)}" target="_blank" rel="noreferrer">${icon.pr(12)}#${pr.n} ${esc(pr.title)}</a>` : ''}
      <div class="dfiles" data-files><div class="quiet"><span class="spin" style="display:inline-grid">${icon.sync(12)}</span></div></div>`;
    store.commit(M.h[c]).then((d) => {
      if (my !== detailToken) return;
      const text = d.message.split('\n').slice(1).join('\n').trim();
      if (text) {
        const b = D.querySelector('[data-body]');
        b.textContent = text;
        b.hidden = false;
      }
      const add = d.files.reduce((s, f) => s + f.add, 0);
      const del = d.files.reduce((s, f) => s + f.del, 0);
      const box = D.querySelector('[data-files]');
      box.innerHTML = `<div class="fh"><span data-tip="改了几个文件">${icon.file(12)} ${d.files.length}</span>${lineStat(add, del)}</div>` + d.files.map((f, i) => `<button class="f" data-f="${i}" title="${esc(f.p)}"><span class="st ${f.st}">${f.st}</span>${filePath(f.p)}${f.bin ? '' : lineStat(f.add, f.del)}</button>`).join('');
      box.onclick = (e) => {
        const bt = e.target.closest('[data-f]');
        if (bt) openChanges({ title: M.s[c], sub: `${M.short(c)} · ${esc(p?.name ?? '')}`, files: d.files, select: d.files[Number(bt.dataset.f)].p, ...commitChangesLoader(store, d.base, d.h) });
      };
    }).catch((e) => {
      if (my === detailToken) D.querySelector('[data-files]').innerHTML = `<div class="quiet">${esc(e.message)}</div>`;
    });
  }

  function showWip(w) {
    detailToken++;
    const files = w.files ?? [];
    D.hidden = false;
    D.innerHTML = `${dtop(null)}
      <h3 class="dsub">${icon.desktop(14)} ${esc(w.path.split('\\').pop())}${w.branch ? ` · ${esc(w.branch)}` : ''}</h3>
      <div class="dmeta muted" style="word-break:break-all">${esc(w.path)}</div>
      <div class="dfiles"><div class="fh"><span data-tip="没提交的文件">${icon.pencil(12)} ${w.total}</span></div>${files.map((f, i) => `<button class="f" data-wf="${i}"><span class="st ${f.st}">${f.st}</span>${filePath(f.p)}${lineStat(f.add, f.del)}</button>`).join('')}</div>`;
    D.querySelector('.dfiles').onclick = (e) => {
      const bt = e.target.closest('[data-wf]');
      if (!bt) return;
      openChanges({
        title: `没提交的改动 · ${w.path.split('\\').pop()}`,
        sub: esc(w.path),
        files,
        select: files[Number(bt.dataset.wf)].p,
        load: (f, opts) => store.wtdiff({ wt: w.id, path: f.p, old: f.old, untracked: f.st === 'U', ctx: opts.ctx, ws: opts.ws }),
      });
    };
  }

  function select(r, { scroll = true, center = false } = {}) {
    if (r < 0 || r >= V.order.length) return;
    selRow = r;
    if (scroll) scrollToRow(r, center);
    paint(true);
    const id = V.order[r];
    if (id >= M.N) {
      showWip(V.wips.get(id).w);
      ctx.setParams({ c: null });
      return;
    }
    S.sel = M.h[id];
    ctx.setParams({ c: S.sel });
    showCommit(id, S.branch);
  }

  /* ================= 环境标签：加 / 改 / 删 ================= */
  function labelEditor(anchor, { branch, env }) {
    closePop();
    document.querySelector('.lpop')?.remove();
    const pop = document.createElement('div');
    pop.className = 'pop lpop';
    pop.innerHTML = `
      <input class="lin" data-name placeholder="生产" value="${esc(env?.name ?? '')}" maxlength="20" data-tip="标签名">
      <input class="lin" data-probe placeholder="https://…/health" value="${esc(env?.probe ?? '')}" data-tip="健康接口地址（可选）：填了就读出线上实际跑的提交，不填就挂在分支最新提交上">
      <div class="lrow">${env ? `<button class="icon-btn" data-del data-tip="删除这个标签">${icon.close(13)}</button>` : ''}<span class="grow"></span><button class="btn primary sm" data-save data-tip="保存">${icon.check(12)}</button></div>`;
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.min(r.left, innerWidth - 300) + 'px';
    pop.style.top = r.bottom + 6 + 'px';
    const name = pop.querySelector('[data-name]');
    const probe = pop.querySelector('[data-probe]');
    setTimeout(() => name.focus(), 0);
    const current = () => C.envs.map((e) => ({ id: e.id, name: e.name, branch: e.branch, probe: e.probe }));
    const close = () => {
      pop.remove();
      document.removeEventListener('mousedown', off);
    };
    const save = async (list) => {
      pop.querySelectorAll('button').forEach((b) => (b.disabled = true));
      try {
        const res = await fetch(`/api/p/${encodeURIComponent(ctx.id)}/labels`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ environments: list }) });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error);
        close();
      } catch (e) {
        toast(e.message);
        pop.querySelectorAll('button').forEach((b) => (b.disabled = false));
      }
    };
    pop.addEventListener('click', (e) => {
      if (e.target.closest('[data-del]')) save(current().filter((x) => x.id !== env.id));
      else if (e.target.closest('[data-save]')) {
        const n = name.value.trim() || name.placeholder;
        const list = current();
        if (env) Object.assign(list.find((x) => x.id === env.id), { name: n, probe: probe.value.trim() || null });
        else list.push({ name: n, branch, probe: probe.value.trim() || null });
        save(list);
      }
    });
    pop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') pop.querySelector('[data-save]').click();
      if (e.key === 'Escape') close();
    });
    const off = (e) => {
      if (!pop.contains(e.target) && !anchor.contains(e.target)) close();
    };
    document.addEventListener('mousedown', off);
  }

  /* ================= 交互 ================= */
  function focusBranch(name, { toggle = true } = {}) {
    S.branch = toggle && S.branch === name ? null : name;
    S.who = null;
    ctx.setParams({ b: S.branch, who: null, c: null });
    drawLeft();
    drawBar();
    compute();
    if (!S.branch) return closeDetail();
    const tip = M.branches.get(S.branch)?.tip ?? -1;
    const r = V.rowOf.get(tip);
    if (r !== undefined) {
      selRow = r;
      scrollToRow(r, true);
    }
    paint(true);
    showBranch(S.branch);
  }

  L.addEventListener('click', (e) => {
    const t = e.target.closest('[data-add-label],[data-edit-label],[data-branch],[data-who],[data-stale-toggle]');
    if (!t) return;
    if (t.dataset.addLabel !== undefined) {
      e.stopPropagation();
      labelEditor(t, { branch: t.dataset.addLabel });
    } else if (t.dataset.editLabel !== undefined) {
      e.stopPropagation();
      labelEditor(t, { env: C.envs.find((x) => x.id === t.dataset.editLabel) });
    } else if (t.dataset.branch !== undefined) focusBranch(t.dataset.branch);
    else if (t.dataset.who !== undefined) {
      const id = Number(t.dataset.who);
      S.who = S.who === id ? null : id;
      S.branch = null;
      ctx.setParams({ who: S.who, b: null });
      drawLeft();
      drawBar();
      compute();
      paint(true);
    } else if (t.dataset.staleToggle !== undefined) {
      L.dataset.stale = L.dataset.stale === '1' ? '0' : '1';
      drawLeft();
    }
  });

  bar.addEventListener('click', (e) => {
    if (e.target.closest('[data-fp]')) {
      S.fp = !S.fp;
      ctx.setParams({ fp: S.fp ? 1 : null });
      drawBar();
      compute();
      reselect();
    } else if (e.target.closest('[data-clear]')) {
      S.branch = null;
      S.who = null;
      ctx.setParams({ b: null, who: null });
      drawLeft();
      drawBar();
      compute();
      closeDetail();
    }
  });
  bar.addEventListener('input', debounce((e) => {
    if (!e.target.matches('[data-q]')) return;
    S.q = e.target.value;
    ctx.setParams({ q: S.q });
    computeMatches();
    paint(true);
    if (V.match?.length) jump(1, true);
  }, 180));
  bar.addEventListener('keydown', (e) => {
    if (!e.target.matches('[data-q]')) return;
    if (e.key === 'Enter') {
      jump(e.shiftKey ? -1 : 1);
      e.preventDefault();
    } else if (e.key === 'Escape') {
      e.target.value = '';
      e.target.dispatchEvent(new Event('input'));
    }
  });
  function jump(dir, fromTop = false) {
    if (!V.match?.length) return;
    let r;
    if (fromTop) r = V.match.find((x) => x >= Math.max(0, selRow)) ?? V.match[0];
    else if (dir > 0) r = V.match.find((x) => x > selRow) ?? V.match[0];
    else r = [...V.match].reverse().find((x) => x < selRow) ?? V.match.at(-1);
    select(r, { center: true });
    computeMatches();
  }

  body.addEventListener('click', (e) => {
    const row = e.target.closest('[data-r]');
    if (!row) return;
    const r = Number(row.dataset.r);
    if (r === selRow && !D.hidden && !S.branch) closeDetail();
    else select(r, { scroll: false });
  });
  list.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'j') { select(Math.min(V.order.length - 1, selRow + 1)); e.preventDefault(); }
    else if (e.key === 'ArrowUp' || e.key === 'k') { select(Math.max(0, selRow - 1)); e.preventDefault(); }
    else if (e.key === 'Escape') D.querySelector('[data-back]') ? showBranch(S.branch) : S.branch ? focusBranch(S.branch) : closeDetail();
  });
  D.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) {
      if (S.branch) focusBranch(S.branch);
      else closeDetail();
    } else if (e.target.closest('[data-back]') && S.branch) {
      ctx.setParams({ c: null });
      showBranch(S.branch);
    } else if (e.target.closest('[data-open]')) {
      const c = Number(e.target.closest('[data-open]').dataset.open);
      const r = V.rowOf.get(c);
      if (r !== undefined) {
        selRow = r;
        scrollToRow(r, true);
        paint(true);
      }
      S.sel = M.h[c];
      ctx.setParams({ c: S.sel });
      showCommit(c, S.branch);
    } else if (e.target.closest('[data-copy]')) copyText(e.target.closest('[data-copy]').dataset.copy);
  });

  function reselect(center = true) {
    const id = S.sel ? M.byHash.get(S.sel) : undefined;
    const r = id !== undefined ? V.rowOf.get(id) : undefined;
    if (r !== undefined) select(r, { center });
    else {
      selRow = -1;
      paint(true);
    }
  }

  /* ================= 开始 ================= */
  function all() {
    prepare();
    drawLeft();
    drawBar();
    compute();
  }
  all();
  // 等布局有了高度再定位（刚挂载时列表还没尺寸，居中会算错）
  const start = () => {
    if (!list.clientHeight) return requestAnimationFrame(start);
    if (S.sel) reselect(true);
    else if (S.branch && M.branches.has(S.branch)) focusBranch(S.branch, { toggle: false });
    else paint(true);
  };
  start();
  list.focus({ preventScroll: true });
  const off = store.on((what) => {
    if (what === 'worktrees') {
      const top = list.scrollTop;
      compute();
      list.scrollTop = top;
      paint(true);
    } else if (what === 'prs') paint(true);
  });

  return {
    update(params) {
      const q = params.get('q') || '';
      if (q !== S.q) {
        S.q = q;
        computeMatches();
        paint(true);
      }
    },
    /** 新快照到了：重读提交图，保持滚动位置和选中 */
    async refresh() {
      const top = list.scrollTop;
      await store.loadModel(true).catch(() => null);
      all();
      list.scrollTop = top;
      const id = S.sel ? M.byHash.get(S.sel) : undefined;
      selRow = id !== undefined ? V.rowOf.get(id) ?? -1 : -1;
      paint(true);
    },
    theme() {
      paint(true);
    },
    unmount() {
      ro.disconnect();
      off();
      document.querySelector('.lpop')?.remove();
      closePop();
    },
  };
}
