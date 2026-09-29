// 分支页：三个标签页。
//   分支 —— 每条分支相对 dev、main 的领先/落后，什么时候进的 dev / main，和远程是否一致，PR，在哪个工作树检出；
//   标签 —— 所有标签与两个标签之间多了多少提交；
//   对比 —— 任选两个引用：分叉点、各自独有的提交、文件差异。
import { esc, icon, avatar, who, ago, stamp, when, num, aheadBehind, lineStat, filePath, picker, debounce } from '../lib/util.js';
import { has } from '../lib/model.js';
import { openChanges } from '../lib/changes.js';
import { commitChangesLoader } from '../lib/commitview.js';

const STATUS = {
  trunk: { label: '主线', hint: '' },
  active: { label: '进行中', hint: '有自己的提交，最近 14 天动过' },
  pending: { label: '待上线', hint: '已合进 dev，还没进 main' },
  stale: { label: '停滞', hint: '有自己的提交，超过 14 天没动' },
  released: { label: '已上线', hint: '已经进了 main' },
  none: { label: '没有独有提交', hint: '分支头就在主线上（刚建、或快进合并过）' },
};
const FOLDED = new Set(['released', 'none']);

export function mount(el, ctx) {
  const { model: M, store } = ctx;
  let tab = ctx.params.get('tab') || 'branches';
  let filter = ctx.params.get('f') || '';
  let q = ctx.params.get('q') || '';
  let cmp = ctx.params.get('cmp') || '';
  const open = new Set();
  let token = 0;

  const label = (st) => (st === 'released' && !M.prodB ? '已合并' : STATUS[st].label);

  el.innerHTML = `<div class="branch-page">
    <div class="toolbar">
      <div class="seg" data-tabs><button data-tab="branches">${icon.branch(13)} 分支 <span class="muted">${M.branches.size}</span></button><button data-tab="tags">${icon.tag(13)} 标签 <span class="muted">${M.tags.length}</span></button><button data-tab="compare">${icon.arrowSwap(13)} 对比</button></div>
      <span class="sep"></span>
      <div class="row" data-tools style="gap:10px;flex-wrap:wrap"></div>
    </div>
    <div class="page" data-body style="padding-top:16px"></div>
  </div>`;
  const tools = el.querySelector('[data-tools]');
  const body = el.querySelector('[data-body]');

  function render() {
    el.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
    if (tab === 'tags') renderTags();
    else if (tab === 'compare') renderCompare();
    else renderBranches();
  }
  function persist() {
    ctx.setParams({ tab: tab === 'branches' ? null : tab, f: tab === 'branches' ? filter : null, q: tab === 'compare' ? null : q, cmp: tab === 'compare' ? cmp : null });
  }

  /* ---------- 分支表 ---------- */
  function renderBranches() {
    const rows = M.analyze().rows;
    const counts = {};
    for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
    tools.innerHTML = `<label class="input" style="width:240px">${icon.search(13)}<input data-q placeholder="搜分支名或负责人" value="${esc(q)}"></label>
      <div class="seg" data-filters><button data-f="">全部 <span class="muted">${rows.length}</span></button>${Object.keys(STATUS).filter((s) => counts[s] && s !== 'trunk').map((s) => `<button data-f="${s}" data-tip="${esc(STATUS[s].hint)}">${label(s)} <span class="muted">${counts[s]}</span></button>`).join('')}</div>`;
    tools.querySelectorAll('[data-f]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === filter)));
    const input = tools.querySelector('[data-q]');
    input.addEventListener('input', debounce(() => { q = input.value.trim(); persist(); drawTable(); }, 150));
    drawTable();
  }
  function drawTable() {
    const rows = M.analyze().rows;
    const ql = q.toLowerCase();
    const shown = rows.filter((r) => (!filter || r.status === filter) && (!ql || r.name.toLowerCase().includes(ql) || M.person(r.owner)?.name.toLowerCase().includes(ql)));
    const dev = M.trunk.dev;
    const prod = M.trunk.prod;
    const groups = new Map();
    for (const r of shown) {
      if (!groups.has(r.status)) groups.set(r.status, []);
      groups.get(r.status).push(r);
    }
    let html = '';
    for (const [status, list] of groups) {
      const folded = FOLDED.has(status) && !filter && !ql && !open.has(status);
      html += `<tr class="grp"><td colspan="9"><div class="row">${label(status)}<span class="muted" style="font-weight:400">${list.length} 条${STATUS[status].hint ? ' · ' + STATUS[status].hint : ''}</span>${FOLDED.has(status) && !filter && !ql ? `<button class="btn sm ghost" data-fold="${status}" style="margin-left:auto">${folded ? '展开' : '收起'}</button>` : ''}</div></td></tr>`;
      if (folded) continue;
      for (const r of list) html += branchRow(r);
    }
    body.innerHTML = `<section class="block"><table class="tbl">
      <thead><tr><th>分支</th><th>负责人</th><th>最后提交</th>${dev ? `<th data-tip="相对 ${esc(dev)}：↑ 分支比 ${esc(dev)} 多的提交 · ↓ ${esc(dev)} 比分支多的提交">对 ${esc(dev)}</th>` : ''}${prod ? `<th data-tip="相对 ${esc(prod)}">对 ${esc(prod)}</th>` : ''}<th>合并进度</th><th data-tip="本机同名分支和云端比">本机</th><th>PR</th><th></th></tr></thead>
      <tbody>${html || '<tr><td colspan="9"><div class="empty">没有匹配的分支</div></td></tr>'}</tbody></table></section>`;
  }
  function branchRow(r) {
    const B = r.B;
    const p = M.person(r.owner);
    const pr = M.prOf(r);
    // 已经进了 dev 的分支和 main 比（看它会给 main 带去什么），其余和 dev 比
    const base = (r.status === 'pending' || r.status === 'released') && M.prodB ? M.prodB.name : M.baseB && M.baseB !== B ? M.baseB.name : M.prodB && M.prodB !== B ? M.prodB.name : '';
    const wts = M.worktrees.filter((w) => w.branch === B.name);
    let progress = '';
    if (r.status === 'trunk') progress = '<span class="muted">—</span>';
    else if (r.mergedProd) progress = `<span class="pill good">${icon.check(11)}进 ${esc(M.trunk.prod)} ${stamp(r.mergedProd.time)}</span>`;
    else if (r.mergedDev) progress = `<span class="pill accent">进 ${esc(M.trunk.dev)} ${stamp(r.mergedDev.time)}</span>`;
    else if (M.baseB) progress = `<span class="muted">未合并</span>`;
    // 本机：同名的本地分支和云端比（来自本机扫描）
    const lb = (ctx.overview.local?.branches ?? []).filter((x) => x.name === B.name);
    let sync = '<span class="faint">—</span>';
    if (lb.length) {
      const up = Math.max(0, ...lb.map((x) => x.unpushed ?? 0));
      const down = Math.max(0, ...lb.map((x) => x.behind ?? 0));
      sync = up || down ? `<span data-tip="本机的 ${esc(B.name)} 比云端：↑ 没推送 · ↓ 没拉取">${aheadBehind(up, down)}</span>` : `<span class="muted" data-tip="本机的 ${esc(B.name)} 和云端一致">${icon.check(11)} 一致</span>`;
    }
    const rel = (x, name) => (x ? aheadBehind(x.ahead, x.behind, { title: `比 ${name} 多 ${x.ahead} 个提交、少 ${x.behind} 个` }) : '');
    return `<tr class="click" data-cmp="${esc(base)}...${esc(B.name)}">
      <td style="max-width:380px"><div class="row">${B.name === M.head ? `<span class="pill accent" data-tip="当前检出">${icon.check(11)}</span>` : ''}<span class="mono ell" style="font-size:12px" title="${esc(B.name)}">${esc(B.name)}</span>${wts.length ? `<span class="muted" data-tip="${esc('在工作树检出：' + wts.map((w) => w.path).join('，'))}">${icon.folder(12)}</span>` : ''}</div></td>
      <td>${who(p, 18)}</td>
      <td class="muted" data-tip="${esc(M.s[r.tip])}">${when(r.time)}</td>
      ${M.trunk.dev ? `<td>${r.status === 'trunk' && B === M.devB ? '<span class="faint">—</span>' : rel(r.rd, M.trunk.dev)}</td>` : ''}
      ${M.trunk.prod ? `<td>${r.status === 'trunk' && B === M.prodB ? '<span class="faint">—</span>' : rel(r.rp, M.trunk.prod)}</td>` : ''}
      <td>${progress}</td>
      <td>${sync}</td>
      <td>${pr ? `<a href="${esc(pr.url)}" target="_blank" rel="noreferrer" class="pr ${pr.state}" data-tip="${esc(pr.title)}">#${pr.n}</a>` : ''}</td>
      <td class="r"><a class="btn sm ghost" href="${ctx.href('graph', { b: B.name })}" data-tip="在提交图里只看这条分支">${icon.commit(12)}</a></td>
    </tr>`;
  }

  /* ---------- 标签 ---------- */
  function renderTags() {
    tools.innerHTML = `<label class="input" style="width:240px">${icon.search(13)}<input data-q placeholder="搜标签" value="${esc(q)}"></label>`;
    const input = tools.querySelector('[data-q]');
    const draw = () => {
      const ql = q.toLowerCase();
      const prodSet = M.prodT?.set;
      const rows = M.tags.map((t, i) => ({ t, prev: M.tags[i + 1] })).filter(({ t }) => !ql || t.name.toLowerCase().includes(ql) || (t.msg ?? '').toLowerCase().includes(ql));
      body.innerHTML = `<section class="block"><table class="tbl"><thead><tr><th>标签</th><th>说明</th><th>日期</th><th>提交</th><th class="num" data-tip="比时间上前一个标签多出的提交">比上一个</th>${prodSet ? `<th>在 ${esc(M.trunk.prod)} 里</th>` : ''}<th></th></tr></thead><tbody>${rows.slice(0, 500).map(({ t, prev }) => `
        <tr class="click" data-cmp="${prev ? esc(prev.name) : ''}...${esc(t.name)}">
          <td><span class="pill">${icon.tag(11)}<span>${esc(t.name)}</span></span>${t.ann ? '' : ' <span class="faint" style="font-size:11px" data-tip="轻量标签：没有说明和打标签的人">轻量</span>'}</td>
          <td class="ell t2" style="max-width:420px" title="${esc(t.msg ?? M.s[t.c])}">${esc(t.msg ?? M.s[t.c])}</td>
          <td class="muted">${stamp(t.date)}</td>
          <td><a class="sha-link" href="${ctx.href('graph', { c: M.h[t.c] })}">${M.short(t.c)}</a></td>
          <td class="num muted">${prev ? '+' + num(M.countDiff(M.anc(t.c), M.anc(prev.c))) : ''}</td>
          ${prodSet ? `<td>${has(prodSet, t.c) ? `<span class="muted">${icon.check(11)}</span>` : '<span class="faint">否</span>'}</td>` : ''}
          <td class="r"><span class="btn sm ghost" data-tip="和上一个标签对比">${icon.arrowSwap(12)}</span></td>
        </tr>`).join('') || '<tr><td colspan="7"><div class="empty">没有标签</div></td></tr>'}</tbody></table></section>`;
    };
    input.addEventListener('input', debounce(() => { q = input.value.trim(); persist(); draw(); }, 150));
    draw();
  }

  /* ---------- 对比 ---------- */
  function defaultCompare() {
    if (M.prodB && M.devB) return `${M.prodB.name}...${M.devB.name}`;
    const base = M.baseB?.name ?? '';
    const other = M.analyze().rows.find((r) => r.status === 'active');
    return `${base}...${other?.name ?? M.head ?? ''}`;
  }
  function refItems() {
    const items = [];
    for (const r of M.analyze().rows) items.push({ value: r.name, label: r.name, group: r.status === 'trunk' ? '主线' : '分支', hint: when(r.time) });
    for (const t of M.tags) items.push({ value: t.name, label: t.name, group: '标签', hint: when(t.date) });
    return items;
  }
  function renderCompare() {
    if (!cmp.includes('...')) cmp = defaultCompare();
    let [base, head] = cmp.split('...');
    if (!base) base = M.baseB && M.baseB.name !== head ? M.baseB.name : M.prodB?.name ?? '';
    tools.innerHTML = `<span class="muted">基准</span>
      <button class="btn" data-pick="base" data-pop-anchor>${icon.branch(12)}<span class="mono">${esc(base || '选择')}</span>${icon.chevronDown(11)}</button>
      <button class="icon-btn" data-swap title="交换">${icon.arrowSwap(14)}</button>
      <span class="muted">对比</span>
      <button class="btn" data-pick="head" data-pop-anchor>${icon.branch(12)}<span class="mono">${esc(head || '选择')}</span>${icon.chevronDown(11)}</button>`;
    const bc = M.resolve(base);
    const hc = M.resolve(head);
    if (bc < 0 || hc < 0) {
      body.innerHTML = `<div class="empty">${bc < 0 && base ? `找不到「${esc(base)}」` : hc < 0 && head ? `找不到「${esc(head)}」` : '选两个分支、标签或提交来对比'}</div>`;
      return;
    }
    const A = M.anc(hc);
    const Bs = M.anc(bc);
    const onlyHead = M.listDiff(A, Bs);
    const onlyBase = M.listDiff(Bs, A);
    let mb = -1;
    for (let i = 0; i < M.N; i++) if (has(A, i) && has(Bs, i)) { mb = i; break; }
    const my = ++token;
    const commitList = (list, empty) => list.length ? list.slice(0, 300).map((c) => `<a class="citem" href="${ctx.href('graph', { c: M.h[c] })}">${avatar(M.person(M.a[c]), 20)}<span class="s">${esc(M.s[c])}</span><span class="muted mono" style="font-size:11.5px">${M.short(c)}</span><span class="m">${esc(M.person(M.a[c])?.name ?? '')} · ${when(M.t[c])}${M.isMerge(c) ? ' · 合并' : ''}</span></a>`).join('') + (list.length > 300 ? `<div class="empty" style="padding:10px">还有 ${list.length - 300} 个</div>` : '') : `<div class="empty">${empty}</div>`;
    body.innerHTML = `<div class="grid" style="gap:16px">
      <section class="block"><div class="block-b"><div class="tiles">
        <div class="tile"><div class="k"><span class="mono">${esc(head)}</span> 独有</div><div class="v">${num(onlyHead.length)}<small>个提交</small></div><div class="d">${esc(base)} 里没有</div></div>
        <div class="tile"><div class="k"><span class="mono">${esc(base)}</span> 独有</div><div class="v">${num(onlyBase.length)}<small>个提交</small></div><div class="d">${onlyBase.length ? `${esc(head)} 落后这么多` : `${esc(head)} 已包含 ${esc(base)} 的全部提交`}</div></div>
        <div class="tile"><div class="k">分叉点</div><div class="v" style="font-size:18px">${mb >= 0 ? ago(M.ct[mb]) : '—'}</div><div class="d">${mb >= 0 ? `<a class="link" href="${ctx.href('graph', { c: M.h[mb] })}">${M.short(mb)}</a> · ${esc(M.s[mb].slice(0, 36))}` : '没有共同祖先'}</div></div>
        <div class="tile"><div class="k">文件变化 · 分叉点 → ${esc(head)}</div><div class="v" data-fcount>…</div><div class="d" data-fstat>计算中</div></div>
      </div></div></section>
      <div class="cmp-cols">
        <section class="block"><div class="block-h"><h2>只在 <span class="mono">${esc(head)}</span> 里</h2><span class="sub">${num(onlyHead.length)} 个</span></div><div class="clist">${commitList(onlyHead, '没有')}</div></section>
        <section class="block"><div class="block-h"><h2>只在 <span class="mono">${esc(base)}</span> 里</h2><span class="sub">${num(onlyBase.length)} 个</span></div><div class="clist">${commitList(onlyBase, '没有')}</div></section>
      </div>
      <section class="block"><div class="block-h"><h2>文件变化</h2><span class="sub">从分叉点到 ${esc(head)}，也就是 ${esc(head)} 合进 ${esc(base)} 会带进去的改动</span><div class="actions"><button class="btn sm" data-open-all hidden>查看全部差异</button></div></div><div class="files" data-files style="max-height:520px;overflow:auto"><div class="loading">加载中…</div></div></section>
    </div>`;
    store.compare(M.h[bc], M.h[hc]).then((d) => {
      if (my !== token) return;
      const add = d.files.reduce((s, f) => s + f.add, 0);
      const del = d.files.reduce((s, f) => s + f.del, 0);
      body.querySelector('[data-fcount]').innerHTML = `${num(d.files.length)}<small>个文件</small>`;
      body.querySelector('[data-fstat]').innerHTML = lineStat(add, del);
      const box = body.querySelector('[data-files]');
      box.innerHTML = d.files.map((f, i) => `<button class="f" data-f="${i}"><span class="st ${f.st}">${f.st}</span>${filePath(f.p)}${f.bin ? '<span class="faint" style="font-size:11px">二进制</span>' : lineStat(f.add, f.del)}</button>`).join('') || '<div class="empty">没有文件变化</div>';
      const openAll = body.querySelector('[data-open-all]');
      openAll.hidden = !d.files.length;
      const show = (path) => openChanges({ title: `${base} ... ${head}`, sub: `分叉点 ${d.mergeBase ? d.mergeBase.slice(0, 7) : '—'} → ${esc(head)}`, files: d.files, select: path, ...commitChangesLoader(store, d.mergeBase, d.headSha) });
      box.onclick = (e) => {
        const b = e.target.closest('[data-f]');
        if (b) show(d.files[Number(b.dataset.f)].p);
      };
      openAll.onclick = () => show(null);
    }, (e) => {
      if (my === token) body.querySelector('[data-files]').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    });
  }

  /* ---------- 交互 ---------- */
  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab],[data-f],[data-fold],[data-cmp],[data-pick],[data-swap]');
    if (!t || e.target.closest('a')) return;
    if (t.dataset.tab) { tab = t.dataset.tab; q = ''; persist(); render(); }
    else if (t.dataset.f !== undefined) { filter = t.dataset.f; persist(); tools.querySelectorAll('[data-f]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === filter))); drawTable(); }
    else if (t.dataset.fold) { open.has(t.dataset.fold) ? open.delete(t.dataset.fold) : open.add(t.dataset.fold); drawTable(); }
    else if (t.dataset.cmp !== undefined) { tab = 'compare'; cmp = t.dataset.cmp; persist(); render(); body.scrollTop = 0; }
    else if (t.dataset.swap !== undefined) { const [a, b] = cmp.split('...'); cmp = `${b}...${a}`; persist(); render(); }
    else if (t.dataset.pick) {
      const which = t.dataset.pick;
      const [a, b] = cmp.split('...');
      picker(t, { items: refItems(), selected: [which === 'base' ? a : b], placeholder: '搜索分支、标签', width: 380, onPick: (v) => { cmp = which === 'base' ? `${v}...${b}` : `${a}...${v}`; persist(); render(); } });
    }
  });

  render();
  const off = store.on((what) => { if (what === 'prs' && tab === 'branches') drawTable(); });
  return {
    update(params) {
      tab = params.get('tab') || 'branches';
      filter = params.get('f') || '';
      q = params.get('q') || '';
      cmp = params.get('cmp') || '';
      render();
    },
    unmount() { off(); },
  };
}
