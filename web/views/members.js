// 成员：第一层是所有人的卡片（提交数、最近动静、手上的分支、14 天节奏），点进去是这个人的详情（第二层，可返回）。
import { esc, icon, avatar, ago, when, fullStamp } from '../lib/util.js';
import { track } from '../lib/flowui.js';
import { branchColor } from '../lib/colors.js';

export function mount(el, ctx) {
  let pid = ctx.sub != null ? Number(ctx.sub) : null;
  el.innerHTML = '<div class="page" data-scroll><div class="members" data-root></div></div>';
  const root = el.querySelector('[data-root]');
  const scroller = el.querySelector('[data-scroll]');

  const trunk = () => {
    const f = ctx.overview.flow ?? [];
    return { main: f.at(-1) ?? null, dev: f.length > 1 ? f[0] : null };
  };
  const bars = (d14, h = 22) => {
    const max = Math.max(1, ...d14);
    return `<span class="bars14" style="height:${h}px">${d14.map((v, i) => `<i class="${v ? '' : 'z'}" style="height:${v ? Math.max(3, Math.round((v / max) * h)) : 2}px" data-tip="${esc(`${i === 13 ? '今天' : 13 - i + ' 天前'}：${v} 个提交`)}"></i>`).join('')}</span>`;
  };

  /* ---------- 第一层：所有人 ---------- */
  function cards() {
    const o = ctx.overview;
    const people = o.people.filter((p) => !p.bot);
    const bots = o.people.filter((p) => p.bot);
    const card = (p) => {
      const person = o.persons[p.id];
      const bs = o.branches.filter((b) => p.branches.includes(b.name));
      const last = o.branches.filter((b) => b.owner === p.id).sort((x, y) => y.time - x.time)[0];
      return `<a class="mcard" href="${ctx.href('people', {}, p.id)}">
        <div class="mtop">${avatar(person, 40)}<div class="mn"><b>${esc(p.name)}</b><span class="muted" data-tip="${fullStamp(p.last)}">${ago(p.last)}</span></div></div>
        ${bars(p.d14)}
        <div class="mstats">
          <span data-tip="近 7 天的提交">${icon.commit(12)}${p.d7}</span>
          <span data-tip="手上的分支">${icon.branch(12)}${bs.length}</span>
          <span data-tip="在途的工作">${icon.flow(12)}${p.items.length}</span>
        </div>
        <div class="mbs">${bs.slice(0, 3).map((b) => `<span class="bpill" style="--c:${branchColor(b.name, trunk())}" data-tip="${esc(b.name)}"><i></i>${esc(b.name.length > 28 ? b.name.slice(0, 27) + '…' : b.name)}</span>`).join('')}${bs.length > 3 ? `<span class="muted">+${bs.length - 3}</span>` : ''}${!bs.length && last ? '' : ''}</div>
      </a>`;
    };
    root.innerHTML = `
      <div class="mgrid">${people.map(card).join('') || '<div class="quiet">最近没有人提交</div>'}</div>
      ${bots.length ? `<h4 class="sub-h" data-tip="Claude、Codex 这类 AI 代理">${icon.info(12)} ${bots.length}</h4><div class="mgrid">${bots.map(card).join('')}</div>` : ''}`;
  }

  /* ---------- 第二层：一个人 ---------- */
  function detail() {
    const o = ctx.overview;
    const p = o.people.find((x) => x.id === pid);
    const person = o.persons[pid];
    if (!p || !person) {
      pid = null;
      return cards();
    }
    const itemsBy = new Map(o.items.map((it) => [it.key, it]));
    const items = p.items.map((k) => itemsBy.get(k)).filter(Boolean);
    const last = o.doneSeg;
    const doing = items.filter((it) => it.seg < last || !last).sort((x, y) => y.last - x.last);
    const done = items.filter((it) => last && it.seg >= last).sort((x, y) => y.last - x.last);
    const bs = o.branches.filter((b) => b.owner === pid && (b.status === 'active' || b.status === 'stale' || Date.now() / 1000 - b.time < 7 * 86400)).sort((x, y) => y.time - x.time);
    const itemRow = (it) => `<a class="mi" href="${ctx.href('graph', { c: it.commits[0].sha })}">${track(o.stages, it.counts, it.count)}${it.ticket ? `<span class="key">${esc(it.ticket)}</span>` : ''}<span class="s">${esc(it.title)}</span><span class="t" data-tip="${fullStamp(it.last)}">${when(it.last)}</span></a>`;
    const statusIcon = (b) => (b.status === 'stale' ? `<span data-tip="超过 30 天没动">${icon.clock(12)}</span>` : b.status === 'merged' || b.status === 'released' ? `<span data-tip="已合进主线">${icon.check(12)}</span>` : `<span class="muted" data-tip="自己的提交">+${b.own}</span>`);
    root.innerHTML = `
      <a class="back" href="${ctx.href('people')}">${icon.arrowLeft(13)}<span>成员</span></a>
      <div class="mhead">${avatar(person, 56)}
        <div><h1>${esc(p.name)}</h1><div class="muted">${(p.names ?? []).filter((n) => n !== p.name).map(esc).join(' · ')}</div></div>
        <span class="grow"></span>
        <div class="mstats big">
          <span data-tip="近 7 天的提交">${icon.commit(14)}${p.d7}</span>
          <span data-tip="近 7 天进了 ${esc(o.stages[0]?.name ?? '主线')} 的提交">${icon.arrowDown(14)}${p.landed}</span>
          <span data-tip="最近一次提交">${icon.clock(14)}${ago(p.last)}</span>
        </div>
      </div>
      ${bars(p.d14, 36)}
      <div class="mcols">
        <section>
          <h4 class="sub-h">${icon.branch(12)} ${bs.length}</h4>
          ${bs.map((b) => `<a class="mb" href="${ctx.href('graph', { b: b.name })}" style="--c:${branchColor(b.name, trunk())}"><i></i><span class="s">${esc(b.name)}</span>${b.pr ? `<span class="pr ${b.pr.state}">#${b.pr.n}</span>` : ''}${statusIcon(b)}<span class="t">${when(b.time)}</span></a>`).join('') || '<div class="quiet">没有分支</div>'}
        </section>
        <section>
          <h4 class="sub-h" data-tip="还没走完全程的工作">${icon.flow(12)} ${doing.length}</h4>
          ${doing.map(itemRow).join('') || '<div class="quiet">没有在途的工作</div>'}
          ${done.length ? `<h4 class="sub-h" data-tip="最近走完全程的">${icon.check(12)} ${done.length}</h4>${done.slice(0, 12).map(itemRow).join('')}` : ''}
        </section>
      </div>`;
  }

  const render = () => (pid != null ? detail() : cards());
  render();
  return {
    update(params, sub) {
      pid = sub != null ? Number(sub) : null;
      render();
      scroller.scrollTop = 0;
    },
    refresh() {
      const top = scroller.scrollTop;
      render();
      scroller.scrollTop = top;
    },
  };
}
