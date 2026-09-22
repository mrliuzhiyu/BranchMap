// 概览：这个仓库现在什么样。
// 第一块回答「dev 和 main 差多少、什么在等上线、main 上有没有没回合到 dev 的改动」；
// 下面分块看分支、成员动态、打开的 PR、版本标签、本机工作区。
import { esc, icon, avatar, who, ago, stamp, when, num, aheadBehind, DAY, nowSec, dayStart } from '../lib/util.js';
import { sparkBars } from '../lib/charts.js';
import { STALE_DAYS } from '../lib/model.js';
import { openWorktreeChanges } from './graph.js';

const RECENT_DAYS = 14;

export function mount(el, ctx) {
  const { model: M, store } = ctx;
  let showTemp = false;
  const graphHref = (c) => ctx.href('graph', { c: M.h[c] });

  function render() {
    const scroll = el.querySelector('.page')?.scrollTop ?? 0;
    el.innerHTML = `<div class="page"><div class="page-narrow">
      ${header()}
      <div class="grid" style="gap:16px">
        ${trunkBlock()}
        <div class="grid g2">${branchBlock()}${peopleBlock()}</div>
        <div class="grid g2">${prBlock()}${tagBlock()}</div>
        ${worktreeBlock()}
      </div>
    </div></div>`;
    el.querySelector('.page').scrollTop = scroll;
  }

  /* ---------- 标题 ---------- */
  function header() {
    const wt = M.worktrees.filter((w) => !w.temp).length;
    return `<div class="page-title">
      <h1>${esc(M.raw.name)}</h1>
      ${M.head ? `<span class="pill accent" data-tip="主工作区当前检出的分支">${icon.branch(12)}<span>${esc(M.head)}</span></span>` : '<span class="pill">游离 HEAD</span>'}
      <span class="muted mono" style="font-size:11.5px">${esc(M.raw.path)}</span>
      ${M.raw.slug ? `<a class="pill quiet link" href="https://github.com/${esc(M.raw.slug)}" target="_blank" rel="noreferrer">${icon.cloud(12)}${esc(M.raw.slug)}</a>` : ''}
      <span class="grow"></span>
      <span class="muted" style="font-size:12px">${num(M.N)} 个提交 · ${M.branches.size} 条分支 · ${M.tags.length} 个标签 · ${wt} 个工作树</span>
    </div>`;
  }

  /* ---------- 主线 ---------- */
  function trunkBlock() {
    const prod = M.trunk.prod;
    const dev = M.trunk.dev;
    if (!M.prodB && !M.devB) {
      return `<section class="block"><div class="block-h"><h2>主线</h2></div><div class="empty">没有找到 main / master / dev 这类主线分支。可以在 config.json 的 trunk 里为这个仓库指定。</div></section>`;
    }
    if (!M.prodB || !M.devB) return singleTrunk(M.prodB ?? M.devB);
    const R = M.trunkRelation();
    const devN = R.devOnly.length;
    const prodWork = R.prodOnly.filter((c) => !M.isMerge(c));
    const prodMerges = R.prodOnly.length - prodWork.length;
    const mb = R.mergeBase;
    const sync = R.sync.map((s) => `<div class="note warn row" style="gap:8px">${icon.alert(13)}<span>本地 <b class="mono">${esc(s.name)}</b> 和 <b class="mono">${esc(s.remote)}</b> 不一致：${s.ahead ? `本地多 ${s.ahead} 个未推送` : ''}${s.ahead && s.behind ? '，' : ''}${s.behind ? `落后 ${s.behind} 个没拉取` : ''}。下面的数字按较新的一方算。</span></div>`).join('');
    return `<section class="block">
      <div class="block-h"><h2>${icon.merge(14)}主线：<span class="mono">${esc(dev)}</span> → <span class="mono">${esc(prod)}</span></h2><span class="sub">功能先合进 ${esc(dev)}，再从 ${esc(dev)} 上线到 ${esc(prod)}</span>
        <div class="actions"><a class="btn sm" href="${ctx.href('graph', { b: [prod, dev].join(','), fp: 1 })}">${icon.commit(13)}在提交图里看主线</a><a class="btn sm" href="${ctx.href('branches', { tab: 'compare', cmp: `${prod}...${dev}` })}">${icon.arrowSwap(13)}对比 ${esc(prod)}...${esc(dev)}</a></div></div>
      <div class="block-b">
        <div class="trunk-wrap">
          ${trunkSvg(R, prodWork.length, prodMerges)}
          <div class="tiles" style="grid-template-columns:repeat(2,minmax(0,1fr))">
            <div class="tile"><div class="k">待上线 · ${esc(dev)} 有、${esc(prod)} 没有</div><div class="v">${num(devN)}<small>个提交</small></div><div class="d">${R.devGroups.filter((g) => g.kind === 'merge').length} 次合并${R.devGroups.some((g) => g.kind === 'direct') ? ' + 直接提交' : ''}${devN ? ` · 最早 ${ago(Math.min(...R.devOnly.map((c) => M.ct[c])))}` : ''}</div></div>
            <div class="tile"><div class="k">未回合 · ${esc(prod)} 有、${esc(dev)} 没有</div><div class="v" style="${prodWork.length ? 'color:var(--warning-ink)' : ''}">${num(prodWork.length)}<small>个改动</small></div><div class="d">${prodWork.length ? `${esc(prod)} 上的改动还没合回 ${esc(dev)}` : `${esc(prod)} 的改动都已在 ${esc(dev)} 里`}${prodMerges ? ` · 另有 ${prodMerges} 个合并提交` : ''}</div></div>
            <div class="tile"><div class="k">上次 ${esc(dev)} → ${esc(prod)}</div><div class="v" style="font-size:18px">${R.lastPromote >= 0 ? ago(M.ct[R.lastPromote]) : '从未'}</div><div class="d">${R.lastPromote >= 0 ? `<a class="link" href="${graphHref(R.lastPromote)}">${M.short(R.lastPromote)}</a> · ${stamp(M.ct[R.lastPromote])}` : `${esc(prod)} 上没有来自 ${esc(dev)} 的合并`}</div></div>
            <div class="tile"><div class="k">分叉点</div><div class="v" style="font-size:18px">${mb >= 0 ? ago(M.ct[mb]) : '—'}</div><div class="d">${mb >= 0 ? `<a class="link" href="${graphHref(mb)}">${M.short(mb)}</a> · ${esc(M.s[mb].slice(0, 40))}` : '没有共同祖先'}</div></div>
          </div>
        </div>
        ${sync ? `<div class="grid" style="gap:8px;margin-top:14px">${sync}</div>` : ''}
      </div>
      <div class="trunk-lists">
        <div>${groupList(R.devGroups, `待上线：${dev} 有、${prod} 没有`, dev, `${prod} 已经包含 ${dev} 的全部提交`)}</div>
        <div>${groupList(R.prodGroups, `未回合：${prod} 有、${dev} 没有`, prod, `${dev} 已经包含 ${prod} 的全部提交`)}</div>
      </div>
    </section>`;
  }

  function trunkSvg(R, prodWork, prodMerges) {
    const W = 600;
    const H = 176;
    const fx = 70;
    const fy = 88;
    const x0 = 140;
    const x1 = 470;
    const lanes = [
      { name: M.trunk.prod, y: 44, color: 'var(--s1)', n: R.prodOnly.length, text: prodWork ? `独有 ${prodWork} 个改动${prodMerges ? ` + ${prodMerges} 个合并` : ''}` : prodMerges ? `只有 ${prodMerges} 个合并提交` : '没有独有提交', tip: M.prodTip },
      { name: M.trunk.dev, y: 132, color: 'var(--s2)', n: R.devOnly.length, text: R.devOnly.length ? `领先 ${num(R.devOnly.length)} 个提交` : '没有独有提交', tip: M.devTip },
    ];
    let out = `<path d="M16 ${fy}H${fx}" style="stroke:var(--line-2);stroke-width:2;fill:none"/><circle cx="${fx}" cy="${fy}" r="5" style="fill:var(--text-2);stroke:var(--surface);stroke-width:2"/>`;
    out += `<text x="${fx}" y="${fy + 24}" text-anchor="middle">分叉点</text>`;
    for (const L of lanes) {
      out += `<path d="M${fx} ${fy}C${fx + 40} ${fy} ${fx + 30} ${L.y} ${x0 - 20} ${L.y}H${x1}" style="stroke:${L.color};stroke-width:2;fill:none;${L.n ? '' : 'stroke-dasharray:4 4'}"/>`;
      const dots = Math.min(L.n, 18);
      for (let i = 0; i < dots; i++) {
        const x = x0 + ((i + 0.5) * (x1 - x0 - 16)) / Math.max(dots, 1);
        if (L.n > 18 && i === dots - 1) { out += `<text x="${x}" y="${L.y + 4}" text-anchor="middle" style="fill:var(--muted)">…</text>`; continue; }
        out += `<circle cx="${x}" cy="${L.y}" r="4" style="fill:${L.color};stroke:var(--surface);stroke-width:2"/>`;
      }
      out += `<circle cx="${x1}" cy="${L.y}" r="7" style="fill:var(--surface);stroke:${L.color};stroke-width:2.5"/>`;
      out += `<text class="lbl" x="${x1 + 16}" y="${L.y - 2}">${esc(L.name)}</text><text x="${x1 + 16}" y="${L.y + 15}">${esc(L.text)}</text>`;
    }
    return `<svg class="trunk-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(M.trunk.dev)} 与 ${esc(M.trunk.prod)} 的分叉示意">${out}</svg>`;
  }

  function groupList(groups, title, lineName, emptyText) {
    const LIMIT = 40;
    const rows = groups.slice(0, LIMIT).map((g) => {
      const lab = g.label;
      const people = g.authors.slice(0, 3).map((id) => avatar(M.person(id), 20)).join('');
      const pr = lab.pr ? `<span class="pr ${lab.pr.state ?? 'MERGED'}">#${lab.pr.n}</span>` : '';
      const br = lab.branch ? `<span class="pill quiet mono" style="font-size:11px">${icon.branch(11)}${esc(lab.branch)}</span>` : '';
      return `<a class="feat" href="${graphHref(g.kind === 'merge' ? g.merge : g.commits[0])}">
        <span class="avs">${people}</span>
        <span class="t"><span class="t1">${pr}<span class="ell">${esc(lab.title)}</span></span><span class="t2 row">${g.kind === 'merge' ? `合入 ${esc(lineName)}` : `直接提交到 ${esc(lineName)}`} · ${when(g.time)}${br}</span></span>
        <span class="muted num" style="font-size:12px">${g.commits.length} 个提交</span>
      </a>`;
    }).join('');
    return `<div class="list-h">${esc(title)}<span class="grow"></span><span class="muted">${groups.length} 项</span></div>
      <div class="clist">${rows || `<div class="empty">${icon.check(14)} ${esc(emptyText)}</div>`}${groups.length > LIMIT ? `<div class="empty" style="padding:12px">还有 ${groups.length - LIMIT} 项，<a class="link" href="${ctx.href('graph', { b: [M.trunk.prod, M.trunk.dev].join(','), fp: 1 })}">到提交图里看</a></div>` : ''}</div>`;
  }

  /** 只有一条主线（没有 dev 或没有 main）：列最近合进来的东西。 */
  function singleTrunk(B) {
    const T = M.trunkInfo(B.tip);
    const since = nowSec() - 30 * DAY;
    const recent = [];
    for (const c of T.chain) {
      if (M.ct[c] < since) break;
      recent.push(c);
    }
    const list = [];
    for (let i = 0; i < M.N; i++) if (T.intro[i] >= 0 && T.intro[i] < recent.length) list.push(i);
    const groups = M.groupByChain(list, T);
    return `<section class="block">
      <div class="block-h"><h2>${icon.merge(14)}主线：<span class="mono">${esc(B.name)}</span></h2><span class="sub">这个仓库没有 ${M.devB ? 'main / master' : 'dev / develop'} 分支，所有分支直接合进 ${esc(B.name)}</span>
        <div class="actions"><a class="btn sm" href="${ctx.href('graph', { b: B.name, fp: 1 })}">${icon.commit(13)}在提交图里看</a></div></div>
      <div class="block-b"><div class="tiles">
        <div class="tile"><div class="k">最新提交</div><div class="v" style="font-size:18px">${ago(M.ct[B.tip])}</div><div class="d"><a class="link" href="${graphHref(B.tip)}">${M.short(B.tip)}</a> · ${esc(M.s[B.tip].slice(0, 36))}</div></div>
        <div class="tile"><div class="k">近 30 天合入</div><div class="v">${groups.filter((g) => g.kind === 'merge').length}<small>次合并</small></div><div class="d">${num(list.length)} 个提交</div></div>
        <div class="tile"><div class="k">近 30 天直接提交</div><div class="v">${groups.filter((g) => g.kind === 'direct').reduce((s, g) => s + g.commits.length, 0)}<small>个</small></div><div class="d">没经过合并、直接在 ${esc(B.name)} 上</div></div>
      </div></div>
      <div style="border-top:1px solid var(--line)">${groupList(groups, `近 30 天进入 ${B.name}`, B.name, '近 30 天没有新东西')}</div>
    </section>`;
  }

  /* ---------- 分支 ---------- */
  function branchBlock() {
    const rows = M.analyze().rows;
    const now = nowSec();
    const count = (s) => rows.filter((r) => r.status === s).length;
    const released = rows.filter((r) => r.status === 'released' && r.mergedProd && now - r.mergedProd.time <= RECENT_DAYS * DAY).length;
    const hasTrunk = M.prodB || M.devB;
    const base = M.baseB?.name;
    const active = rows.filter((r) => r.status === 'active').sort((x, y) => y.time - x.time).slice(0, 8);
    const tile = (k, v, d, filter) => `<a class="tile" href="${ctx.href('branches', { f: filter })}" style="display:block"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></a>`;
    const list = active.map((r) => {
      const rel = M.devB ? r.rd : r.rp;
      const pr = M.prOf(r);
      return `<tr class="click" data-href="${ctx.href('branches', { tab: 'compare', cmp: `${base ?? ''}...${r.name}` })}">
        <td style="width:40%"><div class="row">${avatar(M.person(r.owner), 20)}<span class="ell mono" style="font-size:12px" title="${esc(r.name)}">${esc(r.name)}</span></div></td>
        <td>${rel ? aheadBehind(rel.ahead, rel.behind, { title: `比 ${base} 多 ${rel.ahead} 个提交、少 ${rel.behind} 个` }) : ''}</td>
        <td>${pr ? `<span class="pr ${pr.state}">#${pr.n}</span>` : ''}</td>
        <td class="r muted">${ago(r.time)}</td></tr>`;
    }).join('');
    return `<section class="block">
      <div class="block-h"><h2>${icon.branch(14)}分支</h2><span class="sub">${hasTrunk ? `以 ${esc(base)} 为基准` : ''}</span><div class="actions"><a class="btn sm ghost" href="${ctx.href('branches')}">全部 ${rows.length} 条 ${icon.chevronRight(12)}</a></div></div>
      <div class="block-b">
        <div class="tiles" style="grid-template-columns:repeat(4,minmax(0,1fr))">
          ${tile('进行中', count('active'), `${STALE_DAYS} 天内有提交`, 'active')}
          ${M.devB && M.prodB ? tile('待上线', count('pending'), `进了 ${esc(M.trunk.dev)}，没进 ${esc(M.trunk.prod)}`, 'pending') : ''}
          ${tile(M.prodB ? '近期上线' : '近期合并', released, `${RECENT_DAYS} 天内进了 ${esc(M.trunk.prod ?? M.trunk.dev ?? '')}`, 'released')}
          ${tile('停滞', count('stale'), `超过 ${STALE_DAYS} 天没动`, 'stale')}
        </div>
      </div>
      <div class="list-h" style="border-top:1px solid var(--line)">最近在做的分支<span class="grow"></span><span class="muted">${hasTrunk ? `↑ 比 ${esc(base)} 多 · ↓ 比 ${esc(base)} 少` : ''}</span></div>
      ${list ? `<table class="tbl"><tbody>${list}</tbody></table>` : '<div class="empty">最近没有进行中的分支</div>'}
    </section>`;
  }

  /* ---------- 成员 ---------- */
  function peopleBlock() {
    const now = nowSec();
    const today = dayStart(now);
    const stats = M.peopleStats();
    const rows = [];
    for (const s of stats) {
      const daily = new Array(RECENT_DAYS).fill(0);
      let n = 0;
      for (const c of s.commits) {
        const t = M.t[c];
        if (now - t > RECENT_DAYS * DAY) break;
        const d = Math.round((today - dayStart(t)) / DAY);
        if (d >= 0 && d < RECENT_DAYS) { daily[RECENT_DAYS - 1 - d]++; n++; }
      }
      if (n) rows.push({ s, daily, n, active: s.branches.filter((r) => r.status === 'active').length });
    }
    rows.sort((x, y) => y.n - x.n);
    const quiet = stats.filter((s) => s.commits.length).length - rows.length;
    const body = rows.map(({ s, daily, n, active }) => `<tr class="click" data-href="${ctx.href('people', { p: s.p.id })}">
      <td style="width:34%">${who(s.p, 22)}</td>
      <td>${sparkBars(daily, { w: 112, h: 20, color: s.p.color, title: `近 ${RECENT_DAYS} 天每天的提交数` })}</td>
      <td class="num">${n}<span class="muted"> 提交</span></td>
      <td class="num">${active ? `${active}<span class="muted"> 条进行中</span>` : '<span class="faint">—</span>'}</td>
      <td class="r muted">${ago(s.last)}</td></tr>`).join('');
    return `<section class="block">
      <div class="block-h"><h2>${icon.people(14)}成员动态</h2><span class="sub">近 ${RECENT_DAYS} 天</span><div class="actions"><a class="btn sm ghost" href="${ctx.href('people')}">全部成员 ${icon.chevronRight(12)}</a></div></div>
      ${body ? `<table class="tbl"><tbody>${body}</tbody></table>` : `<div class="empty">近 ${RECENT_DAYS} 天没人提交</div>`}
      ${quiet > 0 ? `<div class="block-f muted" style="justify-content:flex-start;font-size:12px">另有 ${quiet} 人近 ${RECENT_DAYS} 天没有提交</div>` : ''}
    </section>`;
  }

  /* ---------- PR ---------- */
  function prBlock() {
    const st = store.prsState;
    let body;
    if (!st) body = '<div class="loading">正在向 GitHub 读取 PR…</div>';
    else if (!st.available) body = `<div class="empty">读不到 PR：${esc(st.reason)}</div>`;
    else {
      const open = st.list.filter((p) => p.state === 'OPEN' || p.state === 'DRAFT').sort((x, y) => y.updated - x.updated);
      const byLogin = new Map(M.people.filter((p) => p.login).map((p) => [p.login.toLowerCase(), p]));
      body = open.length ? `<table class="tbl"><tbody>${open.slice(0, 10).map((p) => {
        const person = byLogin.get(p.by.toLowerCase());
        return `<tr class="click" data-ext="${esc(p.url)}">
          <td style="width:58%"><div class="row"><span class="pr ${p.state}">#${p.n}</span><span class="ell" title="${esc(p.title)}">${esc(p.title)}</span></div></td>
          <td>${person ? who(person, 18) : `<span class="muted">${esc(p.by)}</span>`}</td>
          <td class="muted mono ell" style="font-size:11.5px;max-width:160px" title="${esc(p.head)} → ${esc(p.base)}">→ ${esc(p.base)}</td>
          <td class="r muted">${ago(p.updated)}</td></tr>`;
      }).join('')}</tbody></table>${open.length > 10 ? `<div class="block-f muted" style="font-size:12px">还有 ${open.length - 10} 个</div>` : ''}` : '<div class="empty">没有打开的 PR</div>';
    }
    const n = st?.available ? st.list.filter((p) => p.state === 'OPEN' || p.state === 'DRAFT').length : null;
    return `<section class="block"><div class="block-h"><h2>${icon.merge(14)}打开的 PR</h2><span class="sub">${n != null ? n + ' 个' : ''}</span>${M.raw.slug ? `<div class="actions"><a class="btn sm ghost" href="https://github.com/${esc(M.raw.slug)}/pulls" target="_blank" rel="noreferrer">GitHub ${icon.ext(12)}</a></div>` : ''}</div>${body}</section>`;
  }

  /* ---------- 标签 ---------- */
  function tagBlock() {
    const tags = M.tags.slice(0, 8);
    const rows = tags.map((t, i) => {
      const prev = M.tags[i + 1];
      const n = prev ? M.countDiff(M.anc(t.c), M.anc(prev.c)) : null;
      return `<tr class="click" data-href="${graphHref(t.c)}">
        <td style="width:30%"><span class="pill">${icon.tag(11)}<span>${esc(t.name)}</span></span></td>
        <td class="ell t2" style="max-width:240px" title="${esc(t.msg ?? M.s[t.c])}">${esc(t.msg ?? M.s[t.c])}</td>
        <td class="num muted">${n != null ? `+${n}` : ''}</td>
        <td class="r muted">${when(t.date)}</td></tr>`;
    }).join('');
    return `<section class="block"><div class="block-h"><h2>${icon.tag(14)}版本标签</h2><span class="sub">${M.tags.length} 个 · 「+n」是比上一个标签多的提交</span><div class="actions"><a class="btn sm ghost" href="${ctx.href('branches', { tab: 'tags' })}">全部 ${icon.chevronRight(12)}</a></div></div>
      ${rows ? `<table class="tbl"><tbody>${rows}</tbody></table>` : '<div class="empty">还没有标签</div>'}</section>`;
  }

  /* ---------- 工作区 ---------- */
  function worktreeBlock() {
    const list = store.wtState;
    let body;
    if (!list) body = '<div class="loading">正在读取工作区状态…</div>';
    else {
      const show = list.map((w, i) => ({ w, i })).filter(({ w }) => !w.temp || showTemp);
      const temp = list.filter((w) => w.temp).length;
      body = `<table class="tbl"><thead><tr><th>位置</th><th>检出</th><th>和上游</th><th class="num">未提交</th></tr></thead><tbody>${show.map(({ w, i }) => `
        <tr class="${w.total ? 'click' : ''}" ${w.total ? `data-wt="${i}"` : ''}>
          <td style="width:40%"><div><b>${w.main ? '主工作区' : esc(w.path.split('\\').pop())}</b>${w.temp ? ' <span class="pill quiet">临时目录</span>' : ''}${w.missing ? ' <span class="pill bad">目录不存在</span>' : ''}</div><div class="faint mono ell" style="font-size:11px;max-width:520px" title="${esc(w.path)}">${esc(w.path)}</div></td>
          <td>${w.branch ? `<span class="pill">${icon.branch(11)}<span>${esc(w.branch)}</span></span>` : '<span class="muted">游离 HEAD</span>'}</td>
          <td>${w.upstream ? `${aheadBehind(w.ahead, w.behind, { title: `相对 ${w.upstream}：↑ 未推送 · ↓ 未拉取` })} <span class="muted mono" style="font-size:11px">${esc(w.upstream)}</span>` : '<span class="faint">没有上游</span>'}</td>
          <td class="num">${w.total ? `<span class="pill warn">${w.total} 个文件</span>` : '<span class="faint">干净</span>'}</td>
        </tr>`).join('')}</tbody></table>
        ${temp ? `<div class="block-f" style="justify-content:flex-start"><button class="btn sm ghost" data-temp>${showTemp ? '收起' : '显示'}临时目录里的 ${temp} 个工作树</button></div>` : ''}`;
    }
    return `<section class="block"><div class="block-h"><h2>${icon.folder(14)}本机工作区</h2><span class="sub">这台电脑上检出的工作树和没提交的文件</span></div>${body}</section>`;
  }

  el.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const t = e.target.closest('[data-href],[data-ext],[data-wt],[data-temp]');
    if (!t) return;
    if (t.dataset.href) location.hash = t.dataset.href.slice(1);
    else if (t.dataset.ext) window.open(t.dataset.ext, '_blank', 'noreferrer');
    else if (t.dataset.wt) openWorktreeChanges(store, store.wtState[Number(t.dataset.wt)], Number(t.dataset.wt), null);
    else if (t.dataset.temp !== undefined) { showTemp = !showTemp; render(); }
  });

  render();
  const off = store.on(() => render());
  return { unmount() { off(); } };
}
