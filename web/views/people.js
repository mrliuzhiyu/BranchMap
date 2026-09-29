// 成员页：每人一张卡——手上在做什么（每件走到了哪一站）、名下的分支、最近 14 天的节奏、刚上线的东西。
// AI 代理（Claude、Codex 这类作者）和最近不活跃的人放在后面折叠起来。
import { esc, icon, avatar, ago, when, fullStamp, debounce, nowSec } from '../lib/util.js';
import { track } from '../lib/flowui.js';
import { openCommitDiff } from '../lib/commitview.js';

const STATUS = {
  active: { label: '进行中', cls: 'accent' },
  stale: { label: '停滞', cls: 'warn' },
  merged: { label: '已合并', cls: '' },
  released: { label: '已上线', cls: 'good' },
};

export function mount(el, ctx) {
  let q = ctx.params.get('q') || '';
  let focus = ctx.params.has('p') ? Number(ctx.params.get('p')) : null;
  let showQuiet = false;

  el.innerHTML = '<div class="page" data-scroll><div class="page-narrow" data-root></div></div>';
  const scroller = el.querySelector('[data-scroll]');
  const root = el.querySelector('[data-root]');

  function render() {
    const o = ctx.overview;
    const last = o.doneSeg;
    const itemsBy = new Map(o.items.map((it) => [it.key, it]));
    const ql = q.trim().toLowerCase();
    const match = (p) => !ql || [p.name, ...(p.names ?? [])].some((n) => n.toLowerCase().includes(ql));
    const people = o.people.filter(match);
    const recentCut = nowSec() - 7 * 86400;
    const busy = people.filter((p) => !p.bot && (p.last >= recentCut || p.branches.length || p.items.some((k) => (itemsBy.get(k)?.seg ?? last) < last)));
    const quiet = people.filter((p) => !busy.includes(p));

    root.innerHTML = `
      <div class="sec-h"><h2>最近在动</h2><span class="tag">${busy.length}</span><span class="sub">${quiet.length ? `另有 ${quiet.length} 位不活跃或是 AI 代理` : ''}</span>
        <span class="aside"><label class="input" style="width:220px">${icon.search(13)}<input data-q placeholder="找人" value="${esc(q)}"></label></span></div>
      <div class="people-grid">${busy.map((p) => card(o, p, itemsBy, last)).join('') || '<div class="empty">没有匹配的人</div>'}</div>
      ${quiet.length ? `<div class="fold-h">${icon.people(13)}不活跃 / AI 代理 · ${quiet.length}<button class="btn sm ghost" data-quiet>${showQuiet ? '收起' : '展开'}</button></div>${showQuiet ? `<div class="people-grid">${quiet.map((p) => card(o, p, itemsBy, last)).join('')}</div>` : ''}` : ''}`;
    if (focus != null) {
      const c = root.querySelector(`[data-person="${focus}"]`);
      if (c) requestAnimationFrame(() => c.scrollIntoView({ block: 'center' }));
    }
  }

  function card(o, p, itemsBy, last) {
    const person = o.persons[p.id];
    const items = p.items.map((k) => itemsBy.get(k)).filter(Boolean);
    const doing = items.filter((it) => it.seg < last || !last).sort((x, y) => y.last - x.last);
    const shipped = items.filter((it) => last && it.seg === last).sort((x, y) => y.last - x.last);
    const branches = o.branches.filter((b) => p.branches.includes(b.name));
    const max = Math.max(1, ...p.d14);
    const bars = p.d14.map((v, i) => `<i class="${v ? '' : 'z'}" style="height:${v ? Math.max(3, Math.round((v / max) * 22)) : 2}px" data-tip="${esc(`${i === 13 ? '今天' : 13 - i + ' 天前'}：${v} 个提交`)}"></i>`).join('');
    const aliases = (p.names ?? []).filter((n) => n !== p.name);
    const itemRow = (it) => `<button class="prow" data-item="${esc(it.key)}" data-sha="${it.commits[0].sha}" data-subject="${esc(it.commits[0].s)}">${track(o.stages, it.counts, it.count)}<span class="s">${it.ticket ? `<span class="key ticket">${esc(it.ticket)}</span>` : it.prs[0] ? `<span class="key">#${it.prs[0].n}</span>` : ''}<span title="${esc(it.title)}">${esc(it.title)}</span></span><span class="muted" style="font-size:12px;white-space:nowrap">${when(it.last)}</span></button>`;
    return `<section class="block person${focus === p.id ? ' focus' : ''}" data-person="${p.id}">
      <div class="person-h">${avatar(person, 36)}
        <div style="min-width:0"><div class="nm">${esc(p.name)}${p.bot ? ' <span class="pill quiet">AI 代理</span>' : ''}</div>
          <div class="sub">${ago(p.last)}活跃 · 近 7 天 ${p.d7} 个提交${p.landed ? ` · ${p.landed} 个进了 ${esc(o.stages[0]?.name ?? '主线')}` : ''}${aliases.length ? ` · 也叫 ${esc(aliases.join('、'))}` : ''}</div></div>
        <span class="grow"></span><span class="bars14" data-tip="近 14 天每天的提交">${bars}</span></div>
      <div class="psec"><h4>在做 · ${doing.length}</h4>${doing.length ? doing.slice(0, 8).map(itemRow).join('') + (doing.length > 8 ? `<a class="prow muted" href="${ctx.href('flow', { who: p.id })}">还有 ${doing.length - 8} 件，在流水线里看全部${icon.chevronRight(11)}</a>` : '') : '<div class="muted" style="padding:2px 16px 6px;font-size:12px">没有在途的工作</div>'}</div>
      ${branches.length ? `<div class="psec"><h4>名下的分支 · ${branches.length}</h4>${branches.slice(0, 8).map((b) => `<a class="prow" href="${ctx.href('branches', { tab: 'compare', cmp: `${o.stages[0]?.name ?? ''}...${b.name}` })}">
          <span class="pill ${STATUS[b.status].cls}"><span>${STATUS[b.status].label}</span></span>
          <span class="s"><span class="mono" style="font-size:12px" title="${esc(b.name)}">${esc(b.name)}</span>${b.pr ? `<span class="pr ${b.pr.state}">#${b.pr.n}</span>` : ''}</span>
          <span class="muted" style="font-size:12px;white-space:nowrap" data-tip="${esc(`自己的提交 ${b.own} 个；${o.stages[0]?.name ?? '主线'} 比它多 ${b.behind ?? 0} 个；最后提交 ${fullStamp(b.time)}`)}"><span class="ab"><span class="up">↑${b.own}</span> <span class="${b.behind ? 'down' : 'zero'}">↓${b.behind ?? 0}</span></span> · ${when(b.time)}</span></a>`).join('')}</div>` : ''}
      ${shipped.length ? `<div class="psec"><h4>${esc(o.segments.find((x) => x.seg === last)?.label ?? '最近上线')} · ${shipped.length}</h4>${shipped.slice(0, 4).map(itemRow).join('')}</div>` : ''}
    </section>`;
  }

  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-quiet],[data-item]');
    if (!t) return;
    if (t.dataset.quiet !== undefined) {
      showQuiet = !showQuiet;
      render();
    } else if (t.dataset.item) {
      openCommitDiff(ctx.store, t.dataset.sha, { subject: t.dataset.subject }).catch((err) => alert(err.message));
    }
  });
  root.addEventListener('input', debounce((e) => {
    if (!e.target.matches('[data-q]')) return;
    q = e.target.value;
    focus = null;
    ctx.setParams({ q, p: null });
    render();
    const inp = root.querySelector('[data-q]');
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
  }, 200));

  render();
  return {
    update(params) {
      q = params.get('q') || '';
      focus = params.has('p') ? Number(params.get('p')) : null;
      render();
    },
    refresh() {
      const top = scroller.scrollTop;
      const f = focus;
      focus = null;
      render();
      focus = f;
      scroller.scrollTop = top;
    },
  };
}

