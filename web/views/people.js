// 成员：左边所有人（按最近活跃排），右边一个人在这个仓库里的情况——
// 手上在做的分支（相对 dev / main 差多少）、最近合进去的工作、每周提交、最近的提交、常改的文件。
import { esc, icon, avatar, ago, stamp, when, num, aheadBehind, DAY, nowSec, weekStart } from '../lib/util.js';
import { sparkBars, columns } from '../lib/charts.js';

const STATUS_LABEL = { active: '进行中', stale: '停滞', pending: '待上线', released: '已上线', none: '无独有提交' };

export function mount(el, ctx) {
  const { model: M, store } = ctx;
  const stats = M.peopleStats().filter((s) => s.commits.length).sort((x, y) => y.last - x.last);
  let sel = ctx.params.has('p') ? Number(ctx.params.get('p')) : stats[0]?.p.id;
  let q = '';

  el.innerHTML = `<div class="people-page">
    <section class="block">
      <div class="block-h"><h2>${icon.people(14)}成员</h2><span class="sub">${stats.length} 人 · 按最近活跃</span></div>
      <div style="padding:8px 10px;border-bottom:1px solid var(--line)"><label class="input">${icon.search(13)}<input data-q placeholder="搜名字"></label></div>
      <div class="plist" data-list></div>
    </section>
    <div class="pdetail" data-detail></div>
  </div>`;
  const listEl = el.querySelector('[data-list]');
  const detail = el.querySelector('[data-detail]');

  function drawList() {
    const ql = q.toLowerCase();
    listEl.innerHTML = stats.filter((s) => !ql || s.p.name.toLowerCase().includes(ql) || s.p.names.some((n) => n.toLowerCase().includes(ql))).map((s) => {
      const active = s.branches.filter((r) => r.status === 'active').length;
      return `<button class="pitem" data-p="${s.p.id}" aria-selected="${s.p.id === sel}">
        ${avatar(s.p, 28)}
        <span style="min-width:0"><span class="n1 ell" style="display:block">${esc(s.p.name)}</span><span class="n2">${ago(s.last)} · 近 30 天 ${s.d30} 个提交${active ? ` · ${active} 条进行中` : ''}</span></span>
        ${sparkBars(s.weeks.slice(-12), { w: 60, h: 18, color: s.p.color, title: '近 12 周每周提交' })}
      </button>`;
    }).join('') || '<div class="empty">没有匹配的人</div>';
  }

  function drawDetail() {
    const s = stats.find((x) => x.p.id === sel);
    if (!s) { detail.innerHTML = '<div class="empty">选一个人</div>'; return; }
    const p = s.p;
    const now = nowSec();
    const working = s.branches.filter((r) => r.status === 'active' || r.status === 'stale').sort((x, y) => y.time - x.time);
    const recentMerged = s.branches.filter((r) => (r.status === 'pending' || r.status === 'released') && now - (r.mergedDev?.time ?? r.mergedProd?.time ?? 0) <= 30 * DAY)
      .sort((x, y) => (y.mergedDev?.time ?? y.mergedProd?.time) - (x.mergedDev?.time ?? x.mergedProd?.time));
    const base = M.baseB?.name;
    const branchRow = (r) => {
      const pr = M.prOf(r);
      const merged = r.mergedProd ? `进 ${esc(M.trunk.prod)} ${stamp(r.mergedProd.time)}` : r.mergedDev ? `进 ${esc(M.trunk.dev)} ${stamp(r.mergedDev.time)}` : '';
      return `<tr class="click" data-href="${ctx.href('branches', { tab: 'compare', cmp: `${base ?? ''}...${r.name}` })}">
        <td style="max-width:360px"><span class="mono ell" style="font-size:12px;display:block" title="${esc(r.name)}">${esc(r.name)}</span></td>
        <td><span class="pill ${r.status === 'active' ? 'accent' : r.status === 'released' ? 'good' : ''}">${STATUS_LABEL[r.status]}</span></td>
        ${M.trunk.dev ? `<td>${r.rd ? aheadBehind(r.rd.ahead, r.rd.behind, { title: `相对 ${M.trunk.dev}` }) : ''}</td>` : ''}
        ${M.trunk.prod ? `<td>${r.rp ? aheadBehind(r.rp.ahead, r.rp.behind, { title: `相对 ${M.trunk.prod}` }) : ''}</td>` : ''}
        <td>${pr ? `<span class="pr ${pr.state}" data-tip="${esc(pr.title)}">#${pr.n}</span>` : ''}</td>
        <td class="muted">${merged || when(r.time)}</td></tr>`;
    };
    const head = `<tr><th>分支</th><th>状态</th>${M.trunk.dev ? `<th>对 ${esc(M.trunk.dev)}</th>` : ''}${M.trunk.prod ? `<th>对 ${esc(M.trunk.prod)}</th>` : ''}<th>PR</th><th>时间</th></tr>`;
    const recent = s.commits.slice(0, 20);
    const thisWeek = weekStart(now);
    const weeks = s.weeks.map((_, i) => thisWeek - (s.weeks.length - 1 - i) * 7 * DAY);

    detail.innerHTML = `
      <section class="block">
        <div class="phead">${avatar(p, 56)}<div style="min-width:0"><h2>${esc(p.name)}</h2>
          <div class="muted" style="font-size:12px;margin-top:2px">${p.names.length > 1 ? `也叫 ${p.names.filter((n) => n !== p.name).map(esc).join('、')} · ` : ''}${p.emails.map(esc).join('、')}</div>
          ${p.login ? `<a class="link" style="font-size:12px" href="https://github.com/${esc(p.login)}" target="_blank" rel="noreferrer">@${esc(p.login)} ${icon.ext(11)}</a>` : ''}</div>
          <span class="grow"></span><a class="btn sm" href="${ctx.href('graph', { a: p.id })}">${icon.commit(13)}在提交图里高亮</a></div>
        <div class="block-b" style="border-top:1px solid var(--line)"><div class="tiles">
          <div class="tile"><div class="k">最近活跃</div><div class="v" style="font-size:18px">${ago(s.last)}</div><div class="d">${stamp(s.last)}</div></div>
          <div class="tile"><div class="k">近 7 天</div><div class="v">${s.d7}<small>个提交</small></div><div class="d">近 30 天 ${s.d30} 个</div></div>
          <div class="tile"><div class="k">手上的分支</div><div class="v">${working.filter((r) => r.status === 'active').length}<small>条进行中</small></div><div class="d">${working.filter((r) => r.status === 'stale').length} 条停滞</div></div>
          <div class="tile"><div class="k">全部提交</div><div class="v">${num(s.commits.length)}</div><div class="d">从 ${stamp(M.t[s.commits.at(-1)])} 起</div></div>
        </div></div>
      </section>
      <section class="block"><div class="block-h"><h2>${icon.branch(14)}手上的分支</h2><span class="sub">还没合进 ${esc(base ?? '主线')} 的</span></div>
        ${working.length ? `<table class="tbl"><thead>${head}</thead><tbody>${working.map(branchRow).join('')}</tbody></table>` : '<div class="empty">没有进行中的分支</div>'}</section>
      <section class="block"><div class="block-h"><h2>${icon.merge(14)}近 30 天合进去的</h2><span class="sub">${recentMerged.length} 条分支</span></div>
        ${recentMerged.length ? `<table class="tbl"><thead>${head}</thead><tbody>${recentMerged.map(branchRow).join('')}</tbody></table>` : '<div class="empty">近 30 天没有合并</div>'}</section>
      <section class="block"><div class="block-h"><h2>每周提交</h2><span class="sub">近 ${s.weeks.length} 周 · 含合并提交</span></div><div class="block-b"><div class="chart" data-weeks></div></div></section>
      <div class="grid g2">
        <section class="block"><div class="block-h"><h2>${icon.commit(14)}最近的提交</h2></div><div class="clist" style="max-height:none">${recent.map((c) => `<a class="citem" href="${ctx.href('graph', { c: M.h[c] })}"><span class="muted mono" style="font-size:11.5px">${M.short(c)}</span><span class="s">${esc(M.s[c])}</span><span class="muted" style="font-size:12px">${when(M.t[c])}</span></a>`).join('')}</div></section>
        <section class="block"><div class="block-h"><h2>${icon.file(14)}常改的文件</h2><span class="sub">全部历史</span></div><div data-files><div class="loading">统计中…</div></div></section>
      </div>`;
    columns(detail.querySelector('[data-weeks]'), { labels: weeks, series: [{ name: p.name, color: p.color, values: s.weeks }], height: 160, xFmt: (t) => { const d = new Date(t * 1000); return `${d.getMonth() + 1}/${d.getDate()}`; }, tipTitle: (i) => `${stamp(weeks[i]).split(' ')[0]} 这一周`, unit: ' 个' });
    const my = sel;
    store.stats(null).then((st) => {
      if (my !== sel) return;
      const files = st.personFiles[p.id] ?? [];
      const box = detail.querySelector('[data-files]');
      const max = files[0]?.[1] ?? 1;
      box.innerHTML = files.length ? `<table class="tbl"><tbody>${files.map(([f, n]) => `<tr class="click" data-file="${esc(f)}"><td class="mono ell" style="font-size:12px;max-width:340px" title="${esc(f)}">${esc(f)}</td><td style="width:140px"><div class="hbar" style="grid-template-columns:minmax(0,1fr) 36px"><span class="track" style="width:${(n / max) * 100}%;background:${p.color}"></span><span class="num">${n}</span></div></td></tr>`).join('')}</tbody></table>` : '<div class="empty">没有数据</div>';
    }).catch((e) => {
      const box = detail.querySelector('[data-files]');
      if (box) box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    });
  }

  el.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const t = e.target.closest('[data-p],[data-href],[data-file]');
    if (!t) return;
    if (t.dataset.p) {
      sel = Number(t.dataset.p);
      ctx.setParams({ p: sel }, { replace: false });
      listEl.querySelectorAll('[data-p]').forEach((b) => b.setAttribute('aria-selected', String(Number(b.dataset.p) === sel)));
      drawDetail();
      detail.scrollTop = 0;
    } else if (t.dataset.href) location.hash = t.dataset.href.slice(1);
    else if (t.dataset.file) location.hash = ctx.href('files', { ref: M.head || M.trunk.dev || M.trunk.prod, path: t.dataset.file, v: 'history' }).slice(1);
  });
  const qi = el.querySelector('[data-q]');
  qi.addEventListener('input', () => { q = qi.value.trim(); drawList(); });

  drawList();
  drawDetail();
  const off = store.on((what) => { if (what === 'prs') drawDetail(); });
  return {
    update(params) {
      if (params.has('p') && Number(params.get('p')) !== sel) {
        sel = Number(params.get('p'));
        drawList();
        drawDetail();
      }
    },
    theme() { drawDetail(); },
    unmount() { off(); },
  };
}
