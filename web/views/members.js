// 成员：第一层是所有人的卡片（最近动静、14 天节奏、手上的工作推到了哪一站、手上的分支），点进去是这个人的详情（第二层，可返回）。
// 详情里每个数字、每一天、每件工作都能就地展开到提交，再点提交去分支图看改动。
import { esc, icon, avatar, ago, when, fullStamp, prChip, dayStart, nowSec, DAY } from '../lib/util.js';
import { track } from '../lib/flowui.js';
import { branchColor } from '../lib/colors.js';

const DONE_SHOWN = 12;
const PANEL_SHOWN = 30;
const ITEM_SHOWN = 20;

export function mount(el, ctx) {
  let pid = ctx.sub != null ? Number(ctx.sub) : null;
  let panel = null; // 头部展开的提交列表：week / landed / ahead / behind / day:<0-13>
  let panelAll = false; // 展开的列表超过 PANEL_SHOWN 条时全部显示
  let open = new Set(); // 展开了的工作
  let openAll = new Set(); // 展开后提交超过 ITEM_SHOWN 个、又点了「+N」全部显示的工作
  let allDone = false; // 「已走完」全部显示
  let focusSeg = ctx.params.has('s') ? Number(ctx.params.get('s')) : null; // 从卡片点某一站进来：滚到那一组
  el.innerHTML = '<div class="page" data-scroll><div class="members" data-root></div></div>';
  const root = el.querySelector('[data-root]');
  const scroller = el.querySelector('[data-scroll]');

  const trunk = () => {
    const f = ctx.overview.flow ?? [];
    return { main: f.at(-1) ?? null, dev: f.length > 1 ? f[0] : null };
  };
  const dayLabel = (i) => (i === 13 ? '今天' : i === 12 ? '昨天' : 13 - i + ' 天前');
  const bars = (d14, h = 22, pick = false) => {
    const max = Math.max(1, ...d14);
    return `<span class="bars14${pick ? ' pick' : ''}" style="height:${h}px">${d14.map((v, i) => `<i class="${v ? '' : 'z'}${pick && panel === 'day:' + i ? ' on' : ''}"${pick && v ? ` data-day="${i}"` : ''} style="height:${v ? Math.max(3, Math.round((v / max) * h)) : 2}px" data-tip="${esc(`${dayLabel(i)}：${v} 个提交${pick && v ? '\n点一下列出来' : ''}`)}"></i>`).join('')}</span>`;
  };
  // 一站的标记：还在分支上 → 分支图标；走完全程 → 对勾；中间 → 停在的那一站的名字
  const segMark = (sg) => {
    const o = ctx.overview;
    if (sg.seg === 0) return icon.branch(12);
    if (o.doneSeg && sg.seg >= o.doneSeg) return icon.check(12);
    return `<span class="fsn">${esc(o.stages[sg.seg - 1]?.name ?? '')}</span>`;
  };
  const itemsOf = (p) => {
    const by = new Map(ctx.overview.items.map((it) => [it.key, it]));
    return p.items.map((k) => by.get(k)).filter(Boolean);
  };

  /* ---------- 第一层：所有人 ---------- */
  function cards() {
    const o = ctx.overview;
    const people = o.people.filter((p) => !p.bot);
    const bots = o.people.filter((p) => p.bot);
    const card = (p) => {
      const person = o.persons[p.id];
      const bs = o.branches.filter((b) => p.branches.includes(b.name));
      const items = itemsOf(p);
      const go = (params = {}) => ctx.href('people', params, p.id);
      // 手上的工作推到了哪一站：每一站几件，点哪一站就进详情、停在那一组
      const flow = o.segments.map((sg, i) => {
        const n = items.filter((it) => it.seg === sg.seg).length;
        return `${i ? '<i class="fsep"></i>' : ''}<a class="fs${n ? '' : ' z'}" href="${go({ s: sg.seg })}" data-tip="${esc(`${sg.label}：${n} 件${sg.hint ? '\n' + sg.hint : ''}`)}">${segMark(sg)}<b>${n}</b></a>`;
      }).join('');
      return `<div class="mcard" data-go="${go()}" style="--pc:${person?.color ?? 'var(--other)'}">
        <a class="mtop" href="${go()}">${avatar(person, 40)}<div class="mn"><b>${esc(p.name)}</b><span data-tip="${fullStamp(p.last)}">${ago(p.last)}</span></div>${p.d7 ? '' : `<span class="idle" data-tip="近 7 天没有提交">${icon.clock(12)}</span>`}</a>
        <div class="mbody">
        <div class="mrow">${bars(p.d14)}<span class="mstats">
          <span data-tip="近 7 天的提交">${icon.commit(12)}${p.d7}</span>
          <span data-tip="手上的分支">${icon.branch(12)}${bs.length}</span>
        </span></div>
        ${o.segments.length ? `<div class="mflow">${flow}</div>` : ''}
        <div class="mbs">${bs.slice(0, 3).map((b) => `<a class="bpill" href="${ctx.href('graph', { b: b.name })}" style="--c:${branchColor(b.name, trunk())}" data-tip-c="${branchColor(b.name, trunk())}" data-tip="${esc(b.name + '\n点击在分支图里看')}"><i></i><span data-mid="${esc(b.name)}">${esc(b.name)}</span></a>`).join('')}${bs.length > 3 ? `<a class="muted" href="${go()}">+${bs.length - 3}</a>` : ''}</div>
        </div>
      </div>`;
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
    const now = nowSec();
    const items = itemsOf(p);
    const last = o.doneSeg;
    const doing = items.filter((it) => it.seg < last || !last).sort((x, y) => y.last - x.last);
    const done = items.filter((it) => last && it.seg >= last).sort((x, y) => y.last - x.last);
    const bs = o.branches.filter((b) => b.owner === pid && (b.status === 'active' || b.status === 'stale' || now - b.time < 7 * 86400)).sort((x, y) => y.time - x.time);
    const T = trunk();

    // 这个人的提交（从各件工作里收，去重）：头部数字、每一天展开用
    const seen = new Set();
    const mine = [];
    for (const it of o.items) for (const c of it.commits) if (c.a === pid && !seen.has(c.sha)) seen.add(c.sha), mine.push(c);
    mine.sort((x, y) => y.t - x.t);
    const base = o.stages.findIndex((s) => s.known);
    const nOf = (pack) => pack?.people.find((x) => x.id === pid)?.n ?? 0;
    const ahead = nOf(o.trunk?.ahead);
    const behind = nOf(o.trunk?.behind);

    const commitTrack = (c) => (c.in ? track(o.stages, c.in.map((v) => (v == null ? null : v ? 1 : 0)), 1) : '');
    const commitRow = (c) => `<a class="mc" href="${ctx.href('graph', { c: c.sha })}" data-tip="在分支图里看这个提交的改动">${commitTrack(c)}<code>${c.sha.slice(0, 7)}</code><span class="s">${esc(c.s)}</span>${c.a !== pid ? avatar(o.persons[c.a], 16) : ''}<span class="t" data-tip="${fullStamp(c.t)}">${when(c.t)}</span></a>`;

    // 头部每个数字点开是什么
    const PANELS = {
      week: { ic: icon.commit, title: '近 7 天的提交', n: p.d7, list: () => mine.filter((c) => c.t >= now - 7 * DAY) },
      landed: { ic: icon.arrowDown, title: `近 7 天进了 ${o.stages[base]?.name ?? '主线'} 的提交`, n: p.landed, list: () => (base < 0 ? [] : mine.filter((c) => c.in?.[base] && (c.ct ?? c.t) >= now - 7 * DAY)) },
      ahead: { ic: icon.arrowUp, title: `在 ${T.dev}、还没进 ${T.main}：等上线`, n: ahead, list: () => (o.trunk?.ahead.commits ?? []).filter((c) => c.a === pid) },
      behind: { ic: icon.alert, title: `在 ${T.main}、没合回 ${T.dev}`, n: behind, list: () => (o.trunk?.behind.commits ?? []).filter((c) => c.a === pid) },
    };
    const panelOf = (k) => {
      if (!k) return null;
      if (k.startsWith('day:')) {
        const i = Number(k.slice(4));
        const d0 = dayStart(now) - (13 - i) * DAY;
        return { ic: icon.clock, title: `${dayLabel(i)}的提交`, n: p.d14[i], list: () => mine.filter((c) => dayStart(c.t) === d0) };
      }
      return PANELS[k] ?? null;
    };
    const P = panelOf(panel);
    if (panel && !P) panel = null;
    const stat = (k, tip) => {
      const x = PANELS[k];
      if (!x.n) return `<span data-tip="${esc(tip)}">${x.ic(14)}0</span>`;
      return `<button class="mst${panel === k ? ' on' : ''}" data-panel="${k}" data-tip="${esc(tip + '\n点一下列出来')}">${x.ic(14)}${x.n}</button>`;
    };
    let panelHtml = '';
    if (P) {
      const rows = P.list();
      const oldest = rows.length ? Math.min(...rows.map((c) => c.t)) : null;
      panelHtml = `<div class="mpanel">
        <div class="mph">${P.ic(13)}<b>${esc(P.title)}</b><span class="muted">${P.n}</span>${(panel === 'ahead' || panel === 'behind') && oldest ? `<span class="muted" data-tip="${fullStamp(oldest)}">· 最早一个 ${ago(oldest)}</span>` : ''}<span class="grow"></span><button class="icon-btn" data-panel-close data-tip="收起 (Esc)">${icon.close(12)}</button></div>
        ${(panelAll ? rows : rows.slice(0, PANEL_SHOWN)).map(commitRow).join('') || '<div class="quiet">列表里没有</div>'}
        ${!panelAll && rows.length > PANEL_SHOWN ? `<button class="more" data-panel-all>+${rows.length - PANEL_SHOWN}</button>` : ''}
        ${P.n > rows.length && rows.length ? `<div class="quiet" data-tip="只列出最近还在流转中的提交">另有 ${P.n - rows.length} 个没列出来</div>` : ''}
      </div>`;
    }

    // 一件工作：点开看它的提交（每个提交各自到了哪一站）、分支、PR、工单
    const itemRow = (it) => {
      const links = [
        ...it.branches.map((b) => `<a class="bpill" href="${ctx.href('graph', { b })}" style="--c:${branchColor(b, T)}" data-tip-c="${branchColor(b, T)}" data-tip="${esc(`${b}\n点击在分支图里看这条分支`)}"><i></i>${esc(b)}</a>`),
        ...it.prs.map((pr) => prChip(pr)),
        it.ticketUrl ? `<a class="key tk" href="${esc(it.ticketUrl)}" target="_blank" rel="noreferrer" data-tip="打开工单">${icon.issue(11)}${esc(it.ticket)}</a>` : '',
      ].filter(Boolean);
      // 只有一个提交、也没有分支 / PR / 工单可看：展开没有新东西，直接去分支图看这个提交
      const flat = it.count === 1 && !links.length;
      const on = !flat && open.has(it.key);
      const others = it.people.filter((x) => x !== pid);
      const inner = `<span class="chev">${flat ? '' : icon.chevronRight(11)}</span>${track(o.stages, it.counts, it.count)}${it.ticket ? `<span class="key">${esc(it.ticket)}</span>` : ''}<span class="s">${esc(it.title)}</span>${others.length ? `<span class="avs">${others.slice(0, 3).map((x) => avatar(o.persons[x], 16)).join('')}</span>` : ''}${it.count > 1 ? `<span class="n" data-tip="${it.count} 个提交">${icon.commit(11)}${it.count}</span>` : ''}<span class="t" data-tip="${fullStamp(it.last)}">${when(it.last)}</span>`;
      if (flat) return `<div class="miw"><a class="mi" href="${ctx.href('graph', { c: it.commits[0].sha })}" data-tip="在分支图里看这个提交的改动">${inner}</a></div>`;
      const head = `<button class="mi" data-item="${esc(it.key)}" aria-expanded="${on}">${inner}</button>`;
      if (!on) return `<div class="miw">${head}</div>`;
      return `<div class="miw open">${head}<div class="mix">
        ${links.length ? `<div class="mlinks">${links.join('')}</div>` : ''}
        ${(openAll.has(it.key) ? it.commits : it.commits.slice(0, ITEM_SHOWN)).map(commitRow).join('')}
        ${!openAll.has(it.key) && it.commits.length > ITEM_SHOWN ? `<button class="more" data-item-all="${esc(it.key)}">+${it.commits.length - ITEM_SHOWN}</button>` : ''}
        ${it.count > it.commits.length && (openAll.has(it.key) || it.commits.length <= ITEM_SHOWN) ? `<div class="quiet">另有 ${it.count - it.commits.length} 个提交没列出来</div>` : ''}
      </div></div>`;
    };
    // 在途的工作按停在哪一站分组
    const groups = o.segments.filter((sg) => !last || sg.seg < last).map((sg) => ({ sg, list: doing.filter((it) => it.seg === sg.seg) })).filter((g) => g.list.length);
    const doneSg = o.segments.find((sg) => last && sg.seg >= last);

    // 分支：进没进两条主线（main 在左、dev 在右；实心 = 已包含，空心 = 还没有）、比 dev 落后多少
    const inDev = (b) => b.status === 'merged' || b.status === 'released';
    const inMain = (b) => b.status === 'released';
    const presence = (b) => (T.dev && T.main
      ? `<span class="pres"><i class="${inMain(b) ? 'on' : ''}" style="--c:${branchColor(T.main, T)}" data-tip="${esc(inMain(b) ? `已进 ${T.main}` : `还没进 ${T.main}`)}"></i><i class="${inDev(b) ? 'on' : ''}" style="--c:${branchColor(T.dev, T)}" data-tip="${esc(inDev(b) ? `已进 ${T.dev}` : `还没进 ${T.dev}`)}"></i></span>`
      : '');
    const statusIcon = (b) => (b.status === 'stale' ? `<span data-tip="超过 ${o.staleDays} 天没动">${icon.clock(12)}</span>` : b.status === 'merged' || b.status === 'released' ? '' : `<span class="muted" data-tip="自己的提交（还没进 ${esc(T.dev ?? '主线')}）">+${b.own}</span>`);
    const behindMark = (b) => (b.behind && !inDev(b) ? `<span class="bh" data-tip="${esc(`落后 ${T.dev ?? '主线'} ${b.behind} 个提交`)}">${icon.arrowDown(11)}${b.behind}</span>` : '');
    const branchRow = (b) => `<a class="mb" href="${ctx.href('graph', { b: b.name })}" style="--c:${branchColor(b.name, T)}"><i></i><span class="s">${esc(b.name)}</span>${b.pr ? `<span class="pr ${b.pr.state}" data-tip="${esc(`PR #${b.pr.n} ${b.pr.title ?? ''}`)}">#${b.pr.n}</span>${prChip(b.pr, { mini: true })}` : ''}${statusIcon(b)}${behindMark(b)}${presence(b)}<span class="t" data-tip="${fullStamp(b.time)}">${when(b.time)}</span></a>`;

    // 在别的成员之间直接切换
    const peers = o.people.filter((x) => !x.bot || x.id === pid).slice(0, 16);
    root.innerHTML = `
      <div class="mnav"><a class="back" href="${ctx.href('people')}" data-tip="返回 (Esc)">${icon.arrowLeft(13)}<span>成员</span></a><span class="grow"></span>
        <span class="mpeers">${peers.map((x) => `<a class="${x.id === pid ? 'on' : ''}" href="${ctx.href('people', {}, x.id)}" style="--pc:${o.persons[x.id]?.color ?? 'var(--other)'}">${avatar(o.persons[x.id], 24)}</a>`).join('')}</span></div>
      <div class="mhead" style="--pc:${person.color ?? 'var(--other)'}">${avatar(person, 56)}
        <div><h1>${esc(p.name)}<a class="icon-btn" href="${ctx.href('graph', { who: pid })}" data-tip="在分支图里只看 TA 的提交">${icon.graph(14)}</a></h1><div class="muted">${(p.names ?? []).filter((n) => n !== p.name).map(esc).join(' · ')}</div></div>
        <span class="grow"></span>
        <span class="mh14">${bars(p.d14, 32, true)}</span>
        <div class="mstats big">
          ${stat('week', '近 7 天的提交')}
          ${base >= 0 ? stat('landed', `近 7 天进了 ${o.stages[base].name} 的提交`) : ''}
          ${o.trunk && ahead ? stat('ahead', `在 ${T.dev}、还没进 ${T.main} 的提交：等上线`) : ''}
          ${o.trunk && behind ? stat('behind', `直接改在 ${T.main}、没合回 ${T.dev} 的提交`) : ''}
          <span data-tip="最近一次提交 ${fullStamp(p.last)}">${icon.clock(14)}${ago(p.last)}</span>
        </div>
      </div>
      ${panelHtml}
      <div class="mcols">
        <section>
          <h4 class="sub-h" data-tip="手上的分支">${icon.branch(12)} ${bs.length}</h4>
          ${bs.map(branchRow).join('') || '<div class="quiet">没有分支</div>'}
        </section>
        <section>
          ${groups.map((g) => `<div class="mgrp" data-seg="${g.sg.seg}"><h4 class="sub-h" data-tip="${esc(g.sg.hint || g.sg.label)}">${segMark(g.sg)}<span>${esc(g.sg.label)}</span><span class="c">${g.list.length}</span></h4>${g.list.map(itemRow).join('')}</div>`).join('') || `<h4 class="sub-h">${icon.flow(12)} 0</h4><div class="quiet">没有在途的工作</div>`}
          ${done.length ? `<div class="mgrp" data-seg="${doneSg?.seg ?? last}"><h4 class="sub-h" data-tip="${esc(doneSg?.hint || '最近走完全程的')}">${icon.check(12)}<span>${esc(doneSg?.label ?? '已走完')}</span><span class="c">${done.length}</span></h4>${(allDone ? done : done.slice(0, DONE_SHOWN)).map(itemRow).join('')}${!allDone && done.length > DONE_SHOWN ? `<button class="more" data-all-done>+${done.length - DONE_SHOWN}</button>` : ''}</div>` : ''}
        </section>
      </div>`;
  }

  const render = () => {
    // 详情页用这个人的颜色（头像外圈、节奏柱），不铺底色
    const color = pid != null ? ctx.overview.persons[pid]?.color : null;
    if (color) root.style.setProperty('--pc', color);
    else root.style.removeProperty('--pc');
    return pid != null ? detail() : cards();
  };
  // 从卡片上点某一站进来：滚到那一组，闪一下
  const toFocus = () => {
    if (focusSeg == null || pid == null) return;
    const g = root.querySelector(`[data-seg="${focusSeg}"]`);
    focusSeg = null;
    if (!g) return;
    g.scrollIntoView({ block: 'start' });
    g.classList.add('flash');
    setTimeout(() => g.classList.remove('flash'), 1200);
  };

  root.addEventListener('click', (e) => {
    const t = e.target;
    const pn = t.closest('[data-panel]');
    const dy = t.closest('[data-day]');
    if (pn || dy) {
      const k = pn ? pn.dataset.panel : 'day:' + dy.dataset.day;
      panel = panel === k ? null : k;
      panelAll = false;
      return render();
    }
    if (t.closest('[data-panel-close]')) {
      panel = null;
      return render();
    }
    if (t.closest('[data-panel-all]')) {
      panelAll = true;
      return render();
    }
    const ia = t.closest('[data-item-all]');
    if (ia) {
      openAll.add(ia.dataset.itemAll);
      return render();
    }
    const it = t.closest('[data-item]');
    if (it) {
      const k = it.dataset.item;
      open.has(k) ? open.delete(k) : open.add(k);
      return render();
    }
    if (t.closest('[data-all-done]')) {
      allDone = true;
      return render();
    }
    // 卡片：卡片里的链接各去各的，点空白处进这个人的详情
    if (t.closest('a, button')) return;
    const card = t.closest('[data-go]');
    if (card) location.hash = card.dataset.go;
  });
  // Esc：先收起展开的列表，再返回成员列表（弹出框、抽屉、输入框里的 Esc 不管）
  const onKey = (e) => {
    if (e.key !== 'Escape' || pid == null || e.defaultPrevented) return;
    if (document.querySelector('.pop, .modal-wrap, .drawer')) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')) return;
    if (panel) {
      panel = null;
      render();
    } else location.hash = ctx.href('people');
  };
  document.addEventListener('keydown', onKey, true);

  render();
  toFocus();
  return {
    update(params, sub) {
      const next = sub != null ? Number(sub) : null;
      if (next !== pid) {
        panel = null;
        panelAll = false;
        open = new Set();
        openAll = new Set();
        allDone = false;
      }
      pid = next;
      focusSeg = params.has('s') ? Number(params.get('s')) : null;
      render();
      scroller.scrollTop = 0;
      toFocus();
    },
    refresh() {
      const top = scroller.scrollTop;
      render();
      scroller.scrollTop = top;
    },
    unmount() {
      document.removeEventListener('keydown', onKey, true);
    },
  };
}
