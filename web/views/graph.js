// 提交图：带泳道的提交列表（虚拟滚动，几万个提交也流畅）+ 右侧提交详情。
// main 的第一父链固定在最左道（蓝），dev 固定在第二道（橙），一眼看出两条主线怎么分叉、谁合进了谁。
import { esc, icon, avatar, when, fullStamp, picker, debounce, toast } from '../lib/util.js';
import { layout, segPath, WIP_COLOR } from '../lib/layout.js';
import { renderCommit } from '../lib/commitview.js';
import { openChanges } from '../lib/changes.js';
import { has } from '../lib/model.js';

const RH = 28;
const LW = 14;
const PAD = 12;
const MAX_LANES = 22;
const OVERSCAN = 14;
const HEAD_H = 30;

function readState(p) {
  return {
    sel: p.get('c') || null,
    branches: (p.get('b') || '').split(',').filter(Boolean),
    author: p.has('a') ? Number(p.get('a')) : null,
    q: p.get('q') || '',
    fp: p.get('fp') === '1',
    remotes: p.get('rm') !== '0',
    tags: p.get('tg') !== '0',
  };
}

export function mount(el, ctx) {
  const { model: M, store } = ctx;
  const N = M.N;
  let S = readState(ctx.params);
  let V = null; // 当前视图：order / rows / 匹配等
  let selRow = -1;
  let painted = { first: -1, last: -1 };
  let cancelDetail = null;
  let detailW = Number(localStorage.getItem('bm-detail-w')) || 460;

  el.innerHTML = `<div class="graph-page">
    <div class="toolbar">
      <button class="btn" data-branches data-pop-anchor>${icon.branch(13)}<span data-branches-label>全部分支</span>${icon.chevronDown(11)}</button>
      <div class="seg" data-presets>
        <button data-preset="all" data-tip="所有分支、标签的全部历史">全部</button>
        ${M.prodB || M.devB ? `<button data-preset="trunk" data-tip="只看 ${esc([M.trunk.prod, M.trunk.dev].filter(Boolean).join(' 和 '))} 的第一父链：两条主线怎么分叉、谁合进了谁">主线</button>` : ''}
        ${M.head ? `<button data-preset="head" data-tip="只看当前检出的 ${esc(M.head)}">当前分支</button>` : ''}
      </div>
      <span class="sep"></span>
      <button class="btn" data-author data-pop-anchor>${icon.people(13)}<span data-author-label>所有人</span>${icon.chevronDown(11)}</button>
      <label class="input" style="width:260px">${icon.search(13)}<input data-q placeholder="搜提交说明、哈希、作者" value="${esc(S.q)}" autocomplete="off"><span class="count" data-qcount></span></label>
      <button class="icon-btn" data-qprev title="上一个匹配 (Shift+Enter)">${icon.chevronDown(13).replace('<svg', '<svg style="transform:rotate(180deg)"')}</button>
      <button class="icon-btn" data-qnext title="下一个匹配 (Enter)">${icon.chevronDown(13)}</button>
      <span class="sep"></span>
      <label class="check" data-tip="只沿第一父走：隐藏被合并进来的分支内部提交，只留主干"><input type="checkbox" data-opt="fp">仅第一父</label>
      <label class="check"><input type="checkbox" data-opt="remotes">远程分支</label>
      <label class="check"><input type="checkbox" data-opt="tags">标签</label>
      <span class="grow"></span>
      <span class="lane-legend">${M.prodB ? `<button class="link-quiet" data-jump="prod" data-tip="跳到 ${esc(M.trunk.prod)} 的最新提交"><i style="background:var(--s1)"></i>${esc(M.trunk.prod)}</button>` : ''}${M.devB ? `<button class="link-quiet" data-jump="dev" data-tip="跳到 ${esc(M.trunk.dev)} 的最新提交"><i style="background:var(--s2)"></i>${esc(M.trunk.dev)}</button>` : ''}<span data-count class="num"></span></span>
    </div>
    <div class="graph-split" style="--detail-w:${detailW}px">
      <div class="glist" tabindex="0">
        <div class="ghead"><div>图</div><div>说明</div><div>作者</div><div>时间</div><div>提交</div></div>
        <div class="gbody"></div>
      </div>
      <div class="gutter" title="拖动调整宽度"></div>
      <aside class="detail"></aside>
    </div>
  </div>`;
  const list = el.querySelector('.glist');
  const body = el.querySelector('.gbody');
  const detail = el.querySelector('.detail');
  const qInput = el.querySelector('[data-q]');

  /* ---------- 计算：哪些提交可见、怎么排泳道 ---------- */
  function wipNodes(visible) {
    const out = [];
    const wts = store.wtState ?? [];
    wts.forEach((w, i) => {
      if (w.temp || !w.total) return;
      const c = M.worktrees.find((x) => x.path === w.path)?.c ?? -1;
      if (c < 0 || (visible && !has(visible, c))) return;
      out.push({ id: N + out.length, c, w, i });
    });
    return out;
  }
  function tipsOf(names) {
    const out = [];
    for (const n of names) {
      const c = M.resolve(n);
      if (c >= 0) out.push(c);
    }
    return out;
  }
  function compute() {
    let visible = null;
    let tips = S.branches.length ? tipsOf(S.branches) : null;
    if (S.fp) {
      tips ??= [...new Set([...M.refs.map((r) => r.c), ...M.worktrees.map((w) => w.c).filter((c) => c >= 0)])];
      visible = new Uint32Array(M.W);
      for (const t of tips) {
        for (let c = t; c !== undefined && !has(visible, c); c = M.P[c][0]) visible[c >>> 5] |= 1 << (c & 31);
      }
    } else if (tips) visible = M.union(tips);

    // 未提交的改动紧贴在它所在的提交上方，虚线只占一行
    const wips = wipNodes(visible);
    const wipAt = new Map();
    for (const x of wips) {
      if (!wipAt.has(x.c)) wipAt.set(x.c, []);
      wipAt.get(x.c).push(x.id);
    }
    const order = [];
    for (let i = 0; i < N; i++) {
      if (visible && !has(visible, i)) continue;
      const w = wipAt.get(i);
      if (w) order.push(...w);
      order.push(i);
    }

    // 固定泳道：main 第一父链 → 0 道；dev 独有的第一父链 → 紧挨着的道
    const pin = new Map();
    const pinColor = new Map();
    let lane = 0;
    if (M.prodTip >= 0) {
      let any = false;
      for (let c = M.prodTip; c !== undefined; c = M.P[c][0]) {
        if (!visible || has(visible, c)) { pin.set(c, 0); any = true; }
      }
      if (any) { pinColor.set(0, 0); lane = 1; }
    }
    if (M.devTip >= 0) {
      let any = false;
      for (let c = M.devTip; c !== undefined && !pin.has(c); c = M.P[c][0]) {
        if (!visible || has(visible, c)) { pin.set(c, lane); any = true; }
      }
      if (any) pinColor.set(lane, 1);
    }
    const wipBy = new Map(wips.map((x) => [x.id, x]));
    const L = layout(order, (id) => (id >= N ? [wipBy.get(id).c] : M.P[id]), pin, pinColor, (id) => id >= N);
    const rowOf = new Map(order.map((id, r) => [id, r]));
    V = { order, rows: L.rows, width: Math.min(L.width, MAX_LANES), wips: wipBy, rowOf, visible };
    computeMatches();
    const gw = PAD * 2 + (V.width - 1) * LW + 6;
    list.style.setProperty('--cols', `${Math.max(gw, 56)}px minmax(320px, 1fr) 150px 128px 74px`);
    list.querySelector('.ghead').style.gridTemplateColumns = 'var(--cols)';
    body.style.height = order.length * RH + 'px';
    V.gw = Math.max(gw, 56);
    el.querySelector('[data-count]').textContent = `${order.length - wips.length} 个提交`;
    painted = { first: -1, last: -1 };
  }
  function computeMatches() {
    const q = S.q.trim().toLowerCase();
    V.match = null;
    if (q) {
      V.match = [];
      const pids = new Set(M.people.filter((p) => p.name.toLowerCase().includes(q) || p.names.some((n) => n.toLowerCase().includes(q))).map((p) => p.id));
      V.order.forEach((id, r) => {
        if (id >= N) return;
        if (M.s[id].toLowerCase().includes(q) || M.h[id].startsWith(q) || pids.has(M.a[id])) V.match.push(r);
      });
      V.matchSet = new Set(V.match);
    }
    const qc = el.querySelector('[data-qcount]');
    qc.textContent = V.match ? `${V.match.length ? (V.match.indexOf(selRow) + 1 || '–') + '/' : ''}${V.match.length}` : '';
  }

  /* ---------- 绘制（只画可见的几十行） ---------- */
  const lx = (l) => PAD + l * LW;
  function refPills(c, color) {
    const refs = M.refsAt.get(c);
    const lc = color >= 0 ? `lane-${color}` : '';
    const items = [];
    const seen = new Set();
    for (const r of refs ?? []) {
      if (r.kind === 'T') continue;
      const name = r.kind === 'L' ? r.name : r.remote === 'origin' ? r.short : r.name;
      if (seen.has(name)) continue;
      const B = M.branches.get(name);
      if (!B) continue;
      const localHere = B.local?.c === c;
      const remoteHere = B.remote?.c === c;
      if (!localHere && !S.remotes) continue;
      seen.add(name);
      const head = localHere && name === M.head;
      const others = M.worktrees.filter((w) => !w.main && w.branch === name);
      const pr = M.prByHead?.get(name);
      const prOpen = pr && (pr.state === 'OPEN' || pr.state === 'DRAFT') ? pr : null;
      const tip = [
        localHere && remoteHere ? `${name}（本地与 ${B.remote.name} 一致）` : localHere ? `${name}（本地${B.remote ? `；${B.remote.name} 在别处` : '，没有推送到远程'}）` : `${B.remote.name}（远程${B.local ? `；本地 ${name} 在别处` : '，本地没有'}）`,
        head ? '当前检出' : '',
        others.length ? '在工作树检出：' + others.map((w) => w.path).join('，') : '',
        prOpen ? `PR #${prOpen.n} ${prOpen.title}` : '',
      ].filter(Boolean).join('\n');
      const label = localHere ? name : B.remote.name;
      const order = name === M.head ? 0 : name === M.trunk.prod ? 1 : name === M.trunk.dev ? 2 : 3;
      items.push({ order, html: `<span class="ref ${lc}${head ? ' head' : ''}${!localHere ? ' remote-only' : ''}" data-tip="${esc(tip)}">${localHere ? icon.branch(11) : ''}${remoteHere ? icon.cloud(11) : ''}<span>${esc(label)}</span>${prOpen ? `<span class="pr ${prOpen.state}">#${prOpen.n}</span>` : ''}${others.length ? icon.folder(10) : ''}</span>` });
    }
    if (S.tags) for (const r of refs ?? []) if (r.kind === 'T') items.push({ order: 4, html: `<span class="ref tag" data-tip="${esc(r.name + (r.msg ? '：' + r.msg : ''))}">${icon.tag(11)}<span>${esc(r.name)}</span></span>` });
    items.sort((a, b) => a.order - b.order);
    if (items.length > 4) {
      const rest = items.splice(3);
      items.push({ html: `<span class="ref more" data-tip-html="1" data-tip="${esc(rest.map((x) => x.html).join('<br>'))}">+${rest.length}</span>` });
    }
    return items.map((x) => x.html).join('');
  }
  function rowHtml(r) {
    const id = V.order[r];
    const row = V.rows[r];
    const style = `top:${r * RH}px;height:${RH}px;grid-template-columns:var(--cols)`;
    if (id >= N) {
      const x = V.wips.get(id);
      const label = x.w.main ? '主工作区' : x.w.path.split('\\').pop();
      return `<div class="grow-r wip${selRow === r ? ' sel' : ''}" data-r="${r}" style="${style}"><div class="gcell-graph"></div><div class="gcell-desc"><span class="ref" style="--lc:var(--muted)">${icon.pencil(11)}<span>${esc(label)}${x.w.branch ? ' · ' + esc(x.w.branch) : ''}</span></span><span class="gsub">未提交的改动 · ${x.w.total} 个文件</span></div><div class="gcell-author muted">—</div><div class="gcell-date">现在</div><div class="gcell-sha"></div></div>`;
    }
    const p = M.person(M.a[id]);
    const dim = S.author != null && M.a[id] !== S.author;
    const match = V.matchSet?.has(r);
    const cls = `grow-r${selRow === r ? ' sel' : ''}${dim ? ' dim' : ''}${match ? ' match' : ''}${M.P[id].length > 1 ? ' merge' : ''}`;
    return `<div class="${cls}" data-r="${r}" style="${style}"><div class="gcell-graph"></div><div class="gcell-desc">${refPills(id, row.color)}<span class="gsub">${esc(M.s[id])}</span></div><div class="gcell-author">${avatar(p, 18)}<span class="ell">${esc(p?.name ?? '?')}</span></div><div class="gcell-date" data-tip="${fullStamp(M.t[id])}">${when(M.t[id])}</div><div class="gcell-sha">${M.short(id)}</div></div>`;
  }
  function svgHtml(first, last) {
    const paths = new Map();
    const add = (cls, d) => paths.set(cls, (paths.get(cls) ?? '') + d);
    const nodes = [];
    for (let r = first; r < last; r++) {
      const row = V.rows[r];
      const y = (r - first) * RH;
      for (const [x1, y1, x2, y2, color] of row.segs) {
        if (x1 >= MAX_LANES && x2 >= MAX_LANES) continue;
        add(color === WIP_COLOR ? 'e wip' : `e l${color}`, segPath(lx(x1), y + y1 * RH, lx(x2), y + y2 * RH));
      }
      const id = V.order[r];
      const cx = lx(Math.min(row.lane, MAX_LANES - 1));
      const cy = y + RH / 2;
      if (id >= N) { nodes.push(`<circle class="n wip" cx="${cx}" cy="${cy}" r="5"/>`); continue; }
      const dim = S.author != null && M.a[id] !== S.author ? ' dimn' : '';
      const merge = M.P[id].length > 1;
      nodes.push(`<circle class="n l${row.color}${merge ? ' merge' : ''}${dim}" cx="${cx}" cy="${cy}" r="${merge ? 3.6 : 4.6}"/>`);
      if (id === M.headCommit) nodes.push(`<circle class="headring" cx="${cx}" cy="${cy}" r="8"/>`);
    }
    let out = '';
    for (const [cls, d] of paths) out += `<path class="${cls}" d="${d}"/>`;
    return `<svg class="gsvg" width="${V.gw}" height="${(last - first) * RH}" style="top:${first * RH}px">${out}${nodes.join('')}</svg>`;
  }
  function paint(force = false) {
    const top = Math.max(0, list.scrollTop - HEAD_H);
    const first = Math.max(0, Math.floor(top / RH) - OVERSCAN);
    const last = Math.min(V.order.length, Math.ceil((top + list.clientHeight) / RH) + OVERSCAN);
    if (!force && first === painted.first && last === painted.last) return;
    painted = { first, last };
    let html = svgHtml(first, last);
    for (let r = first; r < last; r++) html += rowHtml(r);
    body.innerHTML = html || '<div class="empty">没有提交</div>';
  }
  let raf = 0;
  list.addEventListener('scroll', () => {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); });
  });
  const ro = new ResizeObserver(() => paint(true));
  ro.observe(list);

  /* ---------- 选中 ---------- */
  function scrollToRow(r, center = false) {
    const y = HEAD_H + r * RH;
    const h = list.clientHeight;
    if (center) list.scrollTop = Math.max(0, y - h / 2 + RH / 2);
    else if (y < list.scrollTop + HEAD_H) list.scrollTop = y - HEAD_H;
    else if (y + RH > list.scrollTop + h) list.scrollTop = y + RH - h;
  }
  function select(r, { scroll = true, center = false, push = false } = {}) {
    if (r < 0 || r >= V.order.length) return;
    selRow = r;
    const id = V.order[r];
    if (scroll) scrollToRow(r, center);
    paint(true);
    computeMatchesCount();
    cancelDetail?.();
    cancelDetail = null;
    if (id >= N) {
      showWip(V.wips.get(id));
      ctx.setParams({ c: null });
      return;
    }
    S.sel = M.h[id];
    ctx.setParams({ c: M.h[id] }, { replace: !push });
    cancelDetail = renderCommit(detail, {
      store, model: M, c: id, href: ctx.href,
      onNavigate: (hash) => {
        const i = M.byHash.get(hash);
        const rr = V.rowOf.get(i);
        if (rr === undefined) { toast('这个提交在当前筛选下不可见，已切回全部分支'); S.branches = []; S.fp = false; syncToolbar(); compute(); }
        select(V.rowOf.get(i), { center: true, push: true });
      },
    });
  }
  function computeMatchesCount() {
    if (!V.match) return;
    el.querySelector('[data-qcount]').textContent = `${V.match.length ? (V.match.indexOf(selRow) + 1 || '–') + '/' : ''}${V.match.length}`;
  }
  function showWip(x) {
    const w = x.w;
    detail.innerHTML = `<div class="dsec"><p class="dsubject">未提交的改动</p><div class="muted mono" style="font-size:11.5px;margin-top:6px;word-break:break-all">${esc(w.path)}</div></div>
      <div class="dsec"><dl class="kv"><dt>分支</dt><dd>${w.branch ? `<span class="pill">${icon.branch(11)}<span>${esc(w.branch)}</span></span>` : '<span class="muted">游离 HEAD</span>'}</dd>
      ${w.upstream ? `<dt>上游</dt><dd><span class="mono">${esc(w.upstream)}</span>${w.ahead ? `<span class="pill warn">${w.ahead} 个未推送</span>` : ''}${w.behind ? `<span class="pill">${w.behind} 个未拉取</span>` : ''}</dd>` : ''}
      <dt>文件</dt><dd>${w.total} 个（已暂存 ${w.files.filter((f) => f.staged).length}）</dd></dl></div>
      <div class="dsec" style="padding-bottom:6px"><h4>文件<span class="grow"></span><button class="btn sm" data-wip-all>查看全部差异</button></h4><div class="files" style="margin:0 -16px">${w.files.map((f, i) => `<button class="f" data-wf="${i}"><span class="st ${f.st}">${f.st}</span><span class="fp" title="${esc(f.p)}"><span>${esc(f.p)}</span></span>${f.st === 'U' ? '<span class="faint" style="font-size:11px">新文件</span>' : ''}</button>`).join('')}</div></div>`;
    const open = (path) => openWorktreeChanges(store, w, x.i, path);
    detail.onclick = (e) => {
      const b = e.target.closest('[data-wf]');
      if (b) open(w.files[Number(b.dataset.wf)].p);
      if (e.target.closest('[data-wip-all]')) open(null);
    };
  }

  /* ---------- 交互 ---------- */
  body.addEventListener('click', (e) => {
    const row = e.target.closest('[data-r]');
    if (row) select(Number(row.dataset.r), { scroll: false });
  });
  body.addEventListener('dblclick', (e) => {
    const row = e.target.closest('[data-r]');
    if (!row) return;
    detail.querySelector('[data-open-all], [data-wip-all]')?.click();
  });
  list.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'j') { select(Math.min(V.order.length - 1, selRow + 1)); e.preventDefault(); }
    else if (e.key === 'ArrowUp' || e.key === 'k') { select(Math.max(0, selRow - 1)); e.preventDefault(); }
    else if (e.key === 'PageDown') { select(Math.min(V.order.length - 1, selRow + Math.floor(list.clientHeight / RH))); e.preventDefault(); }
    else if (e.key === 'PageUp') { select(Math.max(0, selRow - Math.floor(list.clientHeight / RH))); e.preventDefault(); }
    else if (e.key === 'Home') { select(0); e.preventDefault(); }
    else if (e.key === 'End') { select(V.order.length - 1); e.preventDefault(); }
    else if (e.key === 'Enter') detail.querySelector('[data-open-all], [data-wip-all]')?.click();
  });

  // 拖动分隔条调整详情宽度
  el.querySelector('.gutter').addEventListener('pointerdown', (e) => {
    const split = el.querySelector('.graph-split');
    const startX = e.clientX;
    const startW = detailW;
    const move = (ev) => {
      detailW = Math.max(320, Math.min(900, startW - (ev.clientX - startX)));
      split.style.setProperty('--detail-w', detailW + 'px');
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      try { localStorage.setItem('bm-detail-w', String(detailW)); } catch { /* 无痕模式 */ }
      paint(true);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });

  // 工具栏
  function branchLabel() {
    if (!S.branches.length) return '全部分支';
    if (S.branches.length <= 2) return S.branches.join('、');
    return `${S.branches.length} 个分支`;
  }
  function syncToolbar() {
    el.querySelector('[data-branches-label]').textContent = branchLabel();
    const p = S.author != null ? M.person(S.author) : null;
    el.querySelector('[data-author-label]').textContent = p ? p.name : '所有人';
    el.querySelectorAll('[data-opt]').forEach((i) => (i.checked = S[i.dataset.opt]));
    const trunkSet = [M.trunk.prod, M.trunk.dev].filter((n) => n && M.branches.has(n));
    const preset = !S.branches.length && !S.fp ? 'all' : S.fp && S.branches.length === trunkSet.length && trunkSet.every((n) => S.branches.includes(n)) ? 'trunk' : S.branches.length === 1 && S.branches[0] === M.head && !S.fp ? 'head' : '';
    el.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === preset)));
  }
  function persist() {
    ctx.setParams({ b: S.branches.join(','), a: S.author, q: S.q, fp: S.fp ? 1 : null, rm: S.remotes ? null : 0, tg: S.tags ? null : 0 });
  }
  function refilter({ keepSel = true } = {}) {
    const selId = selRow >= 0 ? V.order[selRow] : null;
    compute();
    syncToolbar();
    persist();
    let r = selId != null ? V.rowOf.get(selId) : undefined;
    if (!keepSel || r === undefined) r = V.order.length ? 0 : -1;
    selRow = -1;
    if (r >= 0) select(r, { center: true });
    else paint(true);
  }
  el.querySelector('.toolbar').addEventListener('click', (e) => {
    const t = e.target.closest('[data-branches],[data-preset],[data-author],[data-qprev],[data-qnext],[data-jump]');
    if (!t) return;
    if (t.dataset.jump) {
      const tip = t.dataset.jump === 'prod' ? M.prodTip : M.devTip;
      const r = V.rowOf.get(tip);
      if (r === undefined) toast('当前筛选下看不到它');
      else select(r, { center: true, push: true });
      return;
    }
    if (t.dataset.preset) {
      const p = t.dataset.preset;
      if (p === 'all') { S.branches = []; S.fp = false; }
      else if (p === 'trunk') { S.branches = [M.trunk.prod, M.trunk.dev].filter((n) => n && M.branches.has(n)); S.fp = true; }
      else if (p === 'head') { S.branches = [M.head]; S.fp = false; }
      refilter();
    } else if (t.dataset.branches !== undefined) {
      const items = [];
      const a = M.analyze();
      for (const r of a.rows) {
        const g = r.status === 'trunk' ? '主线' : r.B.local ? '本地分支' : '仅远程';
        items.push({ value: r.name, label: r.name, group: g, hint: when(r.time), sort: g === '主线' ? 0 : g === '本地分支' ? 1 : 2 });
      }
      items.sort((x, y) => x.sort - y.sort);
      for (const t2 of M.tags) items.push({ value: t2.name, label: t2.name, group: '标签', hint: when(t2.date) });
      picker(t, { items, multi: true, selected: S.branches, placeholder: '搜索分支或标签', width: 380, onPick: debounce((vals) => { S.branches = vals; refilter(); }, 250) });
    } else if (t.dataset.author !== undefined) {
      const stats = M.peopleStats();
      const items = [{ value: '', label: '所有人', html: '<span class="ell">所有人</span>' }, ...[...stats].sort((x, y) => y.last - x.last).filter((s) => s.commits.length).map((s) => ({ value: String(s.p.id), label: s.p.name, hint: `${s.commits.length} 个提交`, html: `${avatar(s.p, 18)}<span class="ell">${esc(s.p.name)}</span>` }))];
      picker(t, { items, selected: [S.author == null ? '' : String(S.author)], placeholder: '搜索成员', onPick: (v) => { S.author = v === '' ? null : Number(v); syncToolbar(); persist(); paint(true); } });
    } else if (t.dataset.qnext !== undefined) jump(1);
    else if (t.dataset.qprev !== undefined) jump(-1);
  });
  el.querySelectorAll('[data-opt]').forEach((i) => i.addEventListener('change', () => {
    S[i.dataset.opt] = i.checked;
    if (i.dataset.opt === 'fp') refilter();
    else { persist(); paint(true); }
  }));
  qInput.addEventListener('input', debounce(() => {
    S.q = qInput.value;
    computeMatches();
    persist();
    paint(true);
    if (V.match?.length) jump(1, true);
  }, 200));
  qInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { jump(e.shiftKey ? -1 : 1); e.preventDefault(); }
    if (e.key === 'Escape') { qInput.value = ''; qInput.dispatchEvent(new Event('input')); }
  });
  function jump(dir, fromTop = false) {
    if (!V.match?.length) return;
    let r;
    if (fromTop) r = V.match.find((x) => x >= Math.max(0, selRow)) ?? V.match[0];
    else if (dir > 0) r = V.match.find((x) => x > selRow) ?? V.match[0];
    else r = [...V.match].reverse().find((x) => x < selRow) ?? V.match.at(-1);
    select(r, { center: true });
  }

  const off = store.on((what) => {
    if (what === 'worktrees') {
      const selId = selRow >= 0 ? V.order[selRow] : null;
      compute();
      if (selId != null && selId < N) selRow = V.rowOf.get(selId) ?? -1;
      paint(true);
    } else if (what === 'prs') paint(true);
  });

  /* ---------- 开始 ---------- */
  compute();
  syncToolbar();
  let start = S.sel ? V.rowOf.get(M.resolve(S.sel)) : undefined;
  if (start === undefined) start = V.rowOf.get(M.headCommit) ?? (V.order.length ? 0 : -1);
  if (start === undefined) start = V.order.length ? 0 : -1;
  if (start >= 0) requestAnimationFrame(() => select(start, { center: true }));
  else {
    paint(true);
    detail.innerHTML = '<div class="detail-empty">没有提交</div>';
  }
  list.focus({ preventScroll: true });

  return {
    update(params) {
      const next = readState(params);
      const same = next.branches.join() === S.branches.join() && next.fp === S.fp;
      const sel = next.sel;
      S = next;
      qInput.value = S.q;
      if (!same) compute();
      else computeMatches();
      syncToolbar();
      const r = sel ? V.rowOf.get(M.resolve(sel)) : undefined;
      if (r !== undefined && r !== selRow) select(r, { center: true });
      else paint(true);
    },
    theme() { paint(true); },
    unmount() {
      ro.disconnect();
      off();
      cancelDetail?.();
    },
  };
}

/** 工作树未提交的改动：打开差异抽屉。 */
export function openWorktreeChanges(store, w, index, path) {
  const group = (f) => (f.st === 'C' ? '冲突' : f.staged && !f.unstaged ? '已暂存' : f.st === 'U' ? '未跟踪' : '未暂存');
  const rank = { 冲突: 0, 已暂存: 1, 未暂存: 2, 未跟踪: 3 };
  const files = [...w.files].sort((x, y) => rank[group(x)] - rank[group(y)]);
  openChanges({
    title: `未提交的改动 · ${w.main ? '主工作区' : w.path.split('\\').pop()}`,
    sub: `${esc(w.path)}${w.branch ? ' · ' + esc(w.branch) : ''}`,
    files,
    select: path,
    groups: group,
    load: (f, opts) => store.wtdiff({ wt: index, path: f.p, old: f.old, untracked: f.st === 'U', ctx: opts.ctx, ws: opts.ws }),
  });
}
