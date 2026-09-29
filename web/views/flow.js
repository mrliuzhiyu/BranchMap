// 流水线页：一个项目的全貌，分三块。
//   上：流水线 —— 分支上 → dev → 测试 → main → 生产，每一站现在在哪、站与站之间差多少、哪里反常。
//   左：在途工作 —— 按工单 / PR / 分支归组，每件工作走到了哪一站；点开看提交和差异。
//   右：健康、最近在动的人、本机。
import { esc, icon, avatar, avatarStack, ago, stamp, fullStamp, when, levelIcon, picker, debounce, span, nowSec } from '../lib/util.js';
import { track, trackLegend, stageIcon, envStateLabel, envLed } from '../lib/flowui.js';
import { openCommitDiff } from '../lib/commitview.js';

export function mount(el, ctx) {
  const { store } = ctx;
  let S = readState(ctx.params);
  const open = new Set();
  let showDone = false;

  el.innerHTML = '<div class="page" data-scroll><div class="page-narrow" data-root></div></div>';
  const scroller = el.querySelector('[data-scroll]');
  const root = el.querySelector('[data-root]');

  function readState(p) {
    return { seg: p.has('seg') ? Number(p.get('seg')) : null, who: p.has('who') ? Number(p.get('who')) : null, q: p.get('q') || '' };
  }
  function persist() {
    ctx.setParams({ seg: S.seg, who: S.who, q: S.q });
  }

  /* ---------- 整页 ---------- */
  function render(changedKeys = new Set()) {
    const o = ctx.overview;
    root.innerHTML = `
      <section class="section" data-pipe>${pipeline(o, changedKeys)}</section>
      <div class="flow-grid">
        <section class="block" data-items>${itemsBlock(o)}</section>
        <div class="flow-side">
          <section class="block aside">${healthBlock(o)}</section>
          <section class="block aside">${peopleBlock(o)}</section>
          <section class="block aside">${localBlock(o)}</section>
        </div>
      </div>`;
  }

  /* ---------- 流水线 ---------- */
  function pipeline(o, changedKeys) {
    if (!o.stages.length) {
      return `<div class="sec-h"><h2>流水线</h2><span class="tag">Pipeline</span></div><div class="note">没有找到 dev / main 这样的主线分支，所以画不出流水线。可以在 config.json 里给这个项目写 <span class="mono">"flow": ["dev", "main"]</span>。下面的在途工作按最近的提交列出。</div>`;
    }
    const persons = o.persons;
    const active = o.branches.filter((b) => b.status === 'active');
    const stale = o.branches.filter((b) => b.status === 'stale');
    const owners = [...new Set(active.map((b) => b.owner))];
    const seg0 = o.segments[0];
    const parts = [];
    parts.push(`<div class="station feat">
      <div class="sh">${icon.branch(14)}分支上<span class="k">还没合进 ${esc(o.stages[0].name)}</span></div>
      <div class="big">${active.length}<small>条活跃分支</small></div>
      <div class="meta">${owners.length ? avatarStack(persons, owners, { max: 6, size: 20 }) : '<span class="muted">没有人在分支上工作</span>'}</div>
      <div class="foot"><span>${seg0.count} 件工作</span>${stale.length ? `<span class="muted" data-tip="${esc(stale.map((b) => b.name).join('\n'))}">· ${stale.length} 条停滞</span>` : ''}</div>
    </div>`);
    parts.push(connector({ pending: seg0.count, reverse: 0, seg: 0, unit: '件', label: '待合入', to: o.stages[0] }));
    o.stages.forEach((s, i) => {
      parts.push(s.kind === 'branch' ? branchStation(o, s, changedKeys.has(s.key)) : envStation(o, s, changedKeys.has(s.key)));
      if (i < o.stages.length - 1) {
        const g = o.gaps[i];
        const next = o.stages[i + 1];
        parts.push(connector({ ...g, seg: g.from + 1, unit: '个提交', label: next.kind === 'env' ? '待部署' : '待合入', to: next, from: o.stages[g.from] }));
      }
    });
    const extra = o.extraEnvs.length ? `<div class="pipe-extra">${o.extraEnvs.map((s) => envStation(o, s, changedKeys.has(s.key))).join('')}</div>` : '';
    return `<div class="sec-h"><h2>流水线</h2><span class="tag">Pipeline</span><span class="aside">点中间的数字，下面只看卡在那一段的工作</span></div>
      <div class="pipe">${parts.join('')}</div>${extra}`;
  }

  function connector({ pending, reverse, oldest, seg, unit, label, to, from }) {
    if (pending == null) {
      return `<div class="conn unk" data-tip="${esc(`${to.name}读不出运行的版本，没法比较`)}"><span class="line"></span><span class="badge">?</span></div>`;
    }
    const pressed = S.seg === seg;
    const cls = pending ? 'has' : 'zero';
    const text = pending ? `${pending} ${label}` : `${icon.check(11)}一致`;
    const tip = pending ? `${pending} ${unit}${from ? `在 ${from.name}、` : '在分支上、'}还没到 ${to.name}${oldest ? `\n最早一个等了 ${span(nowSec() - oldest)}` : ''}\n点击只看这一段` : `${to.name} 已包含${from ? ' ' + from.name + ' 的' : ''}全部${seg === 0 ? '合并' : '提交'}`;
    return `<button class="conn ${cls}" data-seg="${seg}" aria-pressed="${pressed}" data-tip="${esc(tip)}">
      <span class="line"></span>
      ${pending && oldest ? `<span class="age">${icon.clock(10)} ${span(nowSec() - oldest)}</span>` : ''}
      <span class="badge">${text}</span>
      ${reverse ? `<span class="rev pill warn" data-tip="${esc(`${to.name} 有 ${reverse} 个提交是 ${from?.name ?? ''} 没有的：顺序反了`)}">${icon.alert(10)}<span>反向 ${reverse}</span></span>` : ''}
    </button>`;
  }

  function commitMeta(o, tip) {
    if (!tip) return '';
    const p = o.persons[tip.author];
    return `<div class="meta">${avatar(p, 18)}<span class="ell">${esc(p?.name ?? '')}</span><span style="flex:none">· ${ago(tip.ctime)}</span><a class="sha-link" href="${ctx.href('graph', { c: tip.sha })}" data-tip="在提交图里看这个提交">${tip.short}</a></div>`;
  }

  function branchStation(o, s, flash) {
    return `<div class="station${flash ? ' flash' : ''}" data-station="${esc(s.key)}">
      <div class="sh">${icon.branch(14)}<span class="mono" style="font-size:13px">${esc(s.name)}</span><span class="k">分支</span></div>
      <div class="subj" data-tip="${esc(s.tip?.subject ?? '')}">${esc(s.tip?.subject ?? '')}</div>
      ${commitMeta(o, s.tip)}
      <div class="foot">${s.recent24 ? `<span data-tip="最近 24 小时合进 ${esc(s.name)} 的提交">${icon.arrowDown(11)} 24 小时内进来 <b>${s.recent24}</b> 个提交</span>` : '<span class="muted">24 小时内没有新提交</span>'}</div>
    </div>`;
  }

  function envStation(o, s, flash) {
    const r = s.result ?? {};
    const led = envLed(s);
    const state = envStateLabel(s);
    let body;
    if (s.known) body = `<div class="subj" data-tip="${esc(s.tip.subject)}">${esc(s.tip.subject)}</div>${commitMeta(o, s.tip)}`;
    else {
      const why = r.state === 'down' ? r.error : r.state === 'unconfigured' ? '没有配置怎么读这个环境的版本' : r.state === 'pending' ? '正在探测…' : s.foreign ? `运行 ${r.commit.slice(0, 7)}，云端副本里没有这个提交` : r.detail ?? '读不出运行的是哪个提交';
      body = `<div class="subj none">${esc(why ?? '')}</div>${r.lastKnown ? `<div class="meta">上次读到 ${esc(r.lastKnown.version ?? r.lastKnown.commit?.slice(0, 7) ?? '')} · ${ago(Math.floor(r.lastKnown.at / 1000))}</div>` : '<div class="meta">&nbsp;</div>'}`;
    }
    const foot = [];
    if (r.version) foot.push(`<span class="pill" data-tip="接口返回的版本号">${icon.package(11)}<span>${esc(r.version)}</span></span>`);
    if (s.known && s.behindBranch) foot.push(`<span class="pill warn" data-tip="${esc(`${s.branch} 上有 ${s.behindBranch} 个提交还没部署到${s.name}${s.waitingSince ? '，最早一个等了 ' + span(nowSec() - s.waitingSince) : ''}`)}"><span>落后 ${esc(s.branch)} ${s.behindBranch}</span></span>`);
    if (s.known && s.branch && !s.behindBranch && !s.offBranch) foot.push(`<span class="pill good" data-tip="${esc(`运行的就是 ${s.branch} 的最新代码`)}">${icon.check(11)}<span>= ${esc(s.branch)}</span></span>`);
    if (s.known && s.skipCount) foot.push(`<span class="pill warn" data-tip="${esc(`${s.name}有 ${s.skipCount} 个提交是${s.skipOf}没有的：没经过${s.skipOf}就上线了`)}">${icon.alert(11)}<span>比${esc(s.skipOf)}新 ${s.skipCount}</span></span>`);
    if (r.checkedAt) foot.push(`<span class="muted" data-tip="${esc(`探测地址：${s.probeUrl}\n${fullStamp(Math.floor(r.checkedAt / 1000))}${r.latency ? `，用时 ${r.latency} 毫秒` : ''}${r.resolvedBy ? `\n版本来自：${resolvedText(r.resolvedBy)}` : ''}`)}">${ago(Math.floor(r.checkedAt / 1000))}检查</span>`);
    return `<div class="station env ${led}${flash ? ' flash' : ''}" data-station="${esc(s.key)}">
      <div class="sh">${stageIcon(s, 14)}${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noreferrer" data-tip="${esc(s.url)}">${esc(s.name)}</a>` : esc(s.name)}<span class="k"><i class="led ${led}"></i>${esc(state)}</span></div>
      ${body}
      <div class="foot">${foot.join('') || `<span class="muted">${esc(s.note ?? (s.branch ? `从 ${s.branch} 部署` : ''))}</span>`}</div>
    </div>`;
  }
  function resolvedText(b) {
    if (b.kind === 'field') return `接口字段 ${b.field}`;
    if (b.kind === 'tag') return `标签 ${b.tag}`;
    if (b.kind === 'manifest') return `打包清单 ${b.file}`;
    return '';
  }

  /* ---------- 在途工作 ---------- */
  function filtered(o) {
    const q = S.q.trim().toLowerCase();
    return o.items.filter((it) => {
      if (S.who != null && !it.people.includes(S.who)) return false;
      if (q) {
        const hay = [it.title, it.ticket, it.branch, ...it.branches, ...it.prs.map((p) => `#${p.n} ${p.title ?? ''}`), ...it.commits.map((c) => c.s + ' ' + c.sha.slice(0, 7)), ...it.people.map((id) => o.persons[id]?.name)].join('\n').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function itemsBlock(o) {
    const last = o.doneSeg;
    const list = filtered(o);
    const counts = new Map();
    for (const it of list) counts.set(it.seg, (counts.get(it.seg) ?? 0) + 1);
    const inflight = list.filter((it) => it.seg < last || !last).length;
    const who = S.who != null ? o.persons[S.who] : null;
    const chips = [`<button class="chip" data-f="" aria-pressed="${S.seg == null}">全部在途 <span class="n">${inflight}</span></button>`]
      .concat(o.segments.map((sg) => `<button class="chip${counts.get(sg.seg) ? '' : ' zero'}" data-f="${sg.seg}" aria-pressed="${S.seg === sg.seg}" data-tip="${esc(sg.hint)}">${esc(sg.label)} <span class="n">${counts.get(sg.seg) ?? 0}</span></button>`));
    let body = '';
    const shown = S.seg == null ? list : list.filter((it) => it.seg === S.seg);
    const groups = new Map();
    for (const it of shown) {
      if (!groups.has(it.seg)) groups.set(it.seg, []);
      groups.get(it.seg).push(it);
    }
    for (const sg of o.segments) {
      const g = groups.get(sg.seg);
      if (!g) continue;
      const done = last && sg.seg === last;
      const folded = done && S.seg == null && !showDone && !S.q;
      body += `<div class="igrp">${esc(sg.label)}<span class="n">${g.length}</span><span class="h">${esc(sg.hint)}</span>${done && S.seg == null && !S.q ? `<button class="btn sm ghost" data-done style="margin-left:auto">${folded ? '展开' : '收起'}</button>` : ''}</div>`;
      if (folded) continue;
      body += g.map((it) => itemRow(o, it)).join('');
    }
    if (!body) {
      body = `<div class="items-empty">${icon.checkCircle(20)}<span>${S.q || S.who != null ? '没有符合条件的工作' : S.seg != null ? '这一段没有卡着的工作' : '没有在途的工作'}</span>${S.q || S.who != null || S.seg != null ? '<button class="btn sm" data-clear>清除筛选</button>' : ''}</div>`;
    }
    return `<div class="block-h"><h2>在途工作</h2><span class="sub" data-tip="${esc(`按工单 / PR / 分支归组；列出最近 ${o.windowDays} 天有动静的，和所有还没走完的`)}">最近 ${o.windowDays} 天</span>
        <div class="actions">
          <button class="btn sm" data-who data-pop-anchor>${who ? avatar(who, 16) + esc(who.name) : icon.people(12) + '所有人'}${icon.chevronDown(10)}</button>
          <label class="input" style="width:210px;height:28px">${icon.search(12)}<input data-q placeholder="搜工单、标题、分支、提交" value="${esc(S.q)}"></label>
        </div></div>
      <div class="chips">${chips.join('')}<span class="grow"></span>${trackLegend()}</div>
      <div data-list>${body}</div>`;
  }

  function keyBadge(o, it) {
    if (it.kind === 'ticket') return it.ticketUrl ? `<a class="key ticket" href="${esc(it.ticketUrl)}" target="_blank" rel="noreferrer">${esc(it.ticket)}</a>` : `<span class="key ticket">${esc(it.ticket)}</span>`;
    if (it.kind === 'pr') {
      const p = it.prs[0];
      return p?.url ? `<a class="key" href="${esc(p.url)}" target="_blank" rel="noreferrer">${icon.pr(11)}#${p.n}</a>` : `<span class="key">${icon.pr(11)}#${p?.n ?? ''}</span>`;
    }
    if (it.kind === 'branch') return `<span class="key">${icon.branch(11)}分支</span>`;
    return `<span class="key" data-tip="没有工单号、也不是通过合并进来的提交，按人和日期归在一起">直接提交</span>`;
  }

  function itemRow(o, it) {
    const isOpen = open.has(it.key);
    const meta = [];
    if (it.branch) meta.push(`<span>${icon.branch(11)}<span class="ell" style="max-width:260px">${esc(it.branch)}</span></span>`);
    for (const p of it.prs.slice(0, 2)) if (it.kind !== 'pr' || p !== it.prs[0]) meta.push(`<span>${icon.pr(11)}#${p.n}${p.state === 'OPEN' ? ' 打开' : p.state === 'DRAFT' ? ' 草稿' : ''}</span>`);
    if (it.kind === 'direct') meta.push(`<span>${esc(o.persons[it.people[0]]?.name ?? '')} · ${stamp(it.day).replace(/ \d+:\d+$/, '')}</span>`);
    const partial = it.counts.some((n, i) => n != null && n > 0 && n < it.count && i >= it.seg);
    if (partial) meta.push(`<span class="muted" data-tip="这件工作的一部分提交已经走得更远了">${icon.info(11)}部分已前进</span>`);
    return `<div class="item${isOpen ? ' open' : ''}" data-item="${esc(it.key)}">
      <div class="ir" data-toggle role="button" tabindex="0">
        ${track(o.stages, it.counts, it.count)}
        <span class="ititle"><span class="t">${keyBadge(o, it)}<span class="s" title="${esc(it.title)}">${esc(it.title)}</span></span>${meta.length ? `<span class="m">${meta.join('')}</span>` : ''}</span>
        ${avatarStack(o.persons, it.people, { max: 3, size: 20 })}
        <span class="icount">${it.count} 个提交</span>
        <span class="itime" data-tip="${esc('最后一次改动：' + fullStamp(it.last))}">${when(it.last)}</span>
      </div>
      ${isOpen ? itemDetail(o, it) : ''}
    </div>`;
  }

  function itemDetail(o, it) {
    const acts = [];
    acts.push(`<a class="btn sm" href="${ctx.href('graph', { c: it.commits[0].sha })}">${icon.commit(12)}在提交图里看</a>`);
    for (const p of it.prs) if (p.url) acts.push(`<a class="btn sm ghost" href="${esc(p.url)}" target="_blank" rel="noreferrer">${icon.pr(12)}#${p.n} ${esc((p.title ?? '').slice(0, 40))}</a>`);
    for (const b of it.branches.slice(0, 3)) acts.push(`<a class="btn sm ghost" href="${ctx.href('branches', { tab: 'compare', cmp: `${o.stages[0]?.name ?? ''}...${b}` })}" data-tip="和 ${esc(o.stages[0]?.name ?? '')} 对比">${icon.branch(12)}${esc(b)}</a>`);
    const rows = it.commits.map((c) => {
      const p = o.persons[c.a];
      return `<button class="icommit" data-commit="${c.sha}" data-subject="${esc(c.s)}">
        ${track(o.stages, c.in.map((x) => (x == null ? null : x ? 1 : 0)), 1)}
        ${avatar(p, 18)}
        <span class="s" title="${esc(c.s)}">${esc(c.s)}</span>
        <span class="mono muted" style="font-size:11.5px">${c.sha.slice(0, 7)}</span>
        <span class="muted" style="font-size:12px;white-space:nowrap" data-tip="${fullStamp(c.t)}">${when(c.t)}</span>
      </button>`;
    }).join('');
    return `<div class="idetail"><div class="acts">${acts.join('')}<span class="grow"></span><span class="muted" style="font-size:12px">点提交看改了什么</span></div>${rows}${it.count > it.commits.length ? `<div class="muted" style="padding:6px 8px;font-size:12px">还有 ${it.count - it.commits.length} 个提交没列出</div>` : ''}</div>`;
  }

  /* ---------- 右侧 ---------- */
  function healthBlock(o) {
    const h = o.health;
    const n = (l) => h.filter((x) => x.level === l).length;
    const list = h.map((s) => {
      const clickable = s.link ? ' data-link="' + esc(JSON.stringify(s.link)) + '"' : '';
      const tag = s.link ? 'button' : 'div';
      return `<${tag} class="sig"${clickable}>${levelIcon(s.level, 14)}<span class="sig-t">${esc(s.title)}</span>${s.link ? `<span class="go">${icon.chevronRight(12)}</span>` : '<span></span>'}${s.detail ? `<span class="sig-d">${esc(s.detail)}</span>` : ''}</${tag}>`;
    }).join('');
    return `<div class="block-h"><h2>健康</h2><div class="actions">${n('critical') ? `<span class="pill bad">${icon.xCircle(11)}<span>${n('critical')}</span></span>` : ''}${n('warning') ? `<span class="pill warn">${icon.alert(11)}<span>${n('warning')}</span></span>` : ''}${n('info') ? `<span class="pill">${icon.info(11)}<span>${n('info')}</span></span>` : ''}</div></div>
      <div class="sig-list">${list || `<div class="ok-box">${levelIcon('good', 16)}一切正常：环境跟得上分支，没有反向的提交，本机也都推送了</div>`}</div>`;
  }

  function peopleBlock(o) {
    const list = o.people.filter((p) => !p.bot).slice(0, 7);
    const rows = list.map((p) => {
      const person = o.persons[p.id];
      const max = Math.max(1, ...p.d14);
      const bars = p.d14.map((v, i) => `<i class="${v ? '' : 'z'}" style="height:${v ? Math.max(3, Math.round((v / max) * 22)) : 2}px" data-tip="${esc(`${14 - i === 1 ? '今天' : (14 - i - 1) + ' 天前'}：${v} 个提交`)}"></i>`).join('');
      return `<a class="who-row" href="${ctx.href('people', { p: p.id })}">${avatar(person, 28)}<span class="n1 ell">${esc(p.name)}</span><span class="bars14">${bars}</span><span class="n2">${p.items.length ? `${p.items.length} 件工作 · ` : ''}${p.branches.length ? `${p.branches.length} 条分支 · ` : ''}${ago(p.last)}活跃</span></a>`;
    }).join('');
    return `<div class="block-h"><h2>最近在动的人</h2><span class="sub">近 14 天</span><div class="actions"><a class="btn sm ghost" href="${ctx.href('people')}">全部${icon.chevronRight(11)}</a></div></div>
      <div style="padding-bottom:8px">${rows || '<div class="empty">最近没有人提交</div>'}</div>`;
  }

  function localBlock(o) {
    const L = o.local;
    if (!L || !L.checkouts.length) {
      return `<div class="block-h"><h2>本机</h2></div><div class="block-b muted" style="font-size:12.5px;padding-top:6px">这台电脑的扫描目录里没有这个仓库，所以只能看云端。</div>`;
    }
    const c = L.counts;
    const t = (n, label, warn, tip) => `<a class="t${warn && n ? ' warn' : ''}" href="${ctx.href('local')}" data-tip="${esc(tip)}"><b>${n}</b><span>${label}</span></a>`;
    return `<div class="block-h"><h2>本机</h2><span class="sub">${c.checkouts} 个工作区 · ${ago(Math.floor(L.scannedAt / 1000))}扫描</span><div class="actions"><a class="btn sm ghost" href="${ctx.href('local')}">详情${icon.chevronRight(11)}</a></div></div>
      <div class="mini-tiles">
        ${t(c.unpushedBranches, `条分支没推送${c.unpushedCommits ? `（${c.unpushedCommits} 个提交）` : ''}`, true, '本机有、云端任何分支都没有的提交')}
        ${t(c.behind, '个工作区落后云端', false, '云端有新提交，本机还没拉')}
        ${t(c.dirty, '个工作区有改动', false, '改了还没提交的文件')}
        ${t(L.stashes, '个 stash', false, 'git stash 里存着的改动')}
      </div>`;
  }

  /* ---------- 交互 ---------- */
  function redrawItems() {
    const box = root.querySelector('[data-items]');
    if (box) box.innerHTML = itemsBlock(ctx.overview);
    root.querySelectorAll('[data-seg]').forEach((b) => b.setAttribute('aria-pressed', String(S.seg === Number(b.dataset.seg))));
  }
  function setSeg(seg, scroll = true) {
    S.seg = seg;
    persist();
    redrawItems();
    if (scroll) root.querySelector('[data-items]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  root.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-seg],[data-f],[data-toggle],[data-commit],[data-done],[data-clear],[data-who],[data-link]');
    if (!t) return;
    const a = e.target.closest('a');
    if (a && a !== t && t.contains(a)) return; // 行里的链接（工单、PR、提交号）照常跳转
    if (t.dataset.seg !== undefined) {
      const seg = Number(t.dataset.seg);
      setSeg(S.seg === seg ? null : seg);
    } else if (t.dataset.f !== undefined) setSeg(t.dataset.f === '' ? null : Number(t.dataset.f), false);
    else if (t.dataset.toggle !== undefined) {
      const key = t.closest('[data-item]').dataset.item;
      open.has(key) ? open.delete(key) : open.add(key);
      const it = ctx.overview.items.find((x) => x.key === key);
      const box = t.closest('[data-item]');
      if (it) box.outerHTML = itemRow(ctx.overview, it);
    } else if (t.dataset.commit) {
      openCommitDiff(store, t.dataset.commit, { subject: t.dataset.subject }).catch((err) => alert(err.message));
    } else if (t.dataset.done !== undefined) {
      showDone = !showDone;
      redrawItems();
    } else if (t.dataset.clear !== undefined) {
      S = { seg: null, who: null, q: '' };
      persist();
      redrawItems();
    } else if (t.dataset.who !== undefined) {
      const o = ctx.overview;
      const ids = new Set(o.items.flatMap((it) => it.people));
      const items = [{ value: '', label: '所有人', html: '<span class="ell">所有人</span>' }, ...[...ids].map((id) => o.persons[id]).filter(Boolean).sort((x, y) => x.name.localeCompare(y.name)).map((p) => ({ value: String(p.id), label: p.name, hint: `${o.items.filter((it) => it.people.includes(p.id)).length} 件`, html: `${avatar(p, 18)}<span class="ell">${esc(p.name)}</span>` }))];
      picker(t, { items, selected: [S.who == null ? '' : String(S.who)], placeholder: '搜索成员', onPick: (v) => { S.who = v === '' ? null : Number(v); persist(); redrawItems(); } });
    } else if (t.dataset.link) {
      const link = JSON.parse(t.dataset.link);
      if (link.view) ctx.go(link.view);
      else if (link.seg != null) setSeg(link.seg);
      else if (link.env) {
        const st = root.querySelector(`[data-station="e:${CSS.escape(link.env)}"]`);
        st?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        st?.classList.remove('flash');
        void st?.offsetWidth;
        st?.classList.add('flash');
      }
    }
  });
  root.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-toggle]')) {
      e.preventDefault();
      e.target.click();
    }
  });
  root.addEventListener('input', debounce((e) => {
    if (!e.target.matches('[data-q]')) return;
    S.q = e.target.value;
    persist();
    const pos = e.target.selectionStart;
    redrawItems();
    const inp = root.querySelector('[data-q]');
    inp.focus();
    inp.setSelectionRange(pos, pos);
  }, 200));

  render();
  // 一分钟重画一次（「3 分钟前」这类时间）
  const tick = setInterval(() => {
    if (!root.contains(document.activeElement) || document.activeElement === document.body) keepScroll(() => render());
  }, 60000);

  function keepScroll(fn) {
    const top = scroller.scrollTop;
    fn();
    scroller.scrollTop = top;
  }

  return {
    update(params) {
      S = readState(params);
      redrawItems();
    },
    refresh(info) {
      // 新快照到了：站的提交变了就闪一下
      const before = info?.before;
      const changed = new Set();
      if (before?.stages) {
        for (const s of ctx.overview.stages) {
          const b = before.stages.find((x) => x.key === s.key);
          if (b && (b.tip?.sha !== s.tip?.sha || b.result?.state !== s.result?.state)) changed.add(s.key);
        }
      }
      const focused = document.activeElement?.matches?.('[data-q]');
      keepScroll(() => render(changed));
      if (focused) {
        const inp = root.querySelector('[data-q]');
        inp?.focus();
        inp?.setSelectionRange(inp.value.length, inp.value.length);
      }
    },
    unmount() {
      clearInterval(tick);
    },
  };
}
