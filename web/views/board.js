// 看板（首页）：所有项目放在一起看，只回答「现在要注意什么」，每一行都能点进去。
//   需要处理 —— 各项目的严重 / 注意问题，按轻重排
//   项目     —— 每个项目的 main、dev 两条主线和它们的环境：落后多少、是否一致
//   人       —— 谁在忙：手上的分支、最近一次动静（跨项目合并同一个人）
//   本机     —— 我这台电脑上没推送的分支、没提交的改动
// 四个模块互不依赖：各自只读看板数据里自己那一块，各自一个渲染函数。
import { esc, icon, ago, avatar, levelIcon } from '../lib/util.js';
import { request } from '../lib/api.js';
import { MAIN, DEV, branchColor } from '../lib/colors.js';

const LEVEL = { critical: 0, warning: 1, info: 2 };

export function mount(el, { href, addProject }) {
  el.innerHTML = '<div class="page"><div class="board" data-root><div class="quiet pad">…</div></div></div>';
  const root = el.querySelector('[data-root]');
  let data = null;
  let timer = null;
  let showInfo = false;
  let showAllLocal = false;

  async function load() {
    try {
      data = await request('/api/board');
      draw();
    } catch (e) {
      root.innerHTML = `<div class="quiet pad">${icon.alert(14)} ${esc(e.message)}</div>`;
    }
  }

  const P = () => data.projects.filter((p) => p.ready);
  const projTag = (p) => `<span class="ptag">${esc(p.name)}</span>`;
  const linkOf = (p, link) => {
    if (link?.view === 'local') return href(p.id);
    return href(p.id);
  };

  /* ---------- 需要处理 ---------- */
  function issues() {
    const all = [];
    for (const p of P()) for (const s of p.signals) all.push({ p, s });
    for (const p of data.projects.filter((x) => !x.ready && x.sync?.status === 'error')) all.push({ p, s: { level: 'critical', title: '云端副本建不起来', detail: p.sync.error } });
    all.sort((a, b) => LEVEL[a.s.level] - LEVEL[b.s.level]);
    const important = all.filter((x) => x.s.level !== 'info');
    const info = all.filter((x) => x.s.level === 'info');
    const row = ({ p, s }) => `<a class="irow" href="${linkOf(p, s.link)}" data-tip="${esc(s.detail ?? '')}">${levelIcon(s.level, 14)}${projTag(p)}<span class="it">${esc(s.title)}</span>${icon.chevronRight(12)}</a>`;
    return `<section class="mod">
      <h2>${icon.alert(14)}<span>需要处理</span><span class="n">${important.length}</span></h2>
      ${important.map(row).join('') || `<div class="quiet">${levelIcon('good', 14)} 没有要处理的</div>`}
      ${info.length ? `<button class="more" data-info>${showInfo ? icon.chevronDown(11) : icon.chevronRight(11)}${icon.info(11)}<span>${info.length}</span></button>${showInfo ? info.map(row).join('') : ''}` : ''}
    </section>`;
  }

  /* ---------- 项目：主线与环境 ---------- */
  function projects() {
    const rows = data.projects.map((p) => {
      if (!p.ready) return `<a class="prow2 off" href="${href(p.id)}"><span class="pn">${esc(p.name)}</span><span class="quiet">${p.sync?.status === 'error' ? icon.alert(12) : `<span class="spin" style="display:inline-grid">${icon.sync(12)}</span>`}</span></a>`;
      const t = p.trunk ?? {};
      const gapDev = p.gaps && p.stages ? devAhead(p) : 0;
      const railHtml = (name, color) => {
        if (!name) return '';
        const envs = p.envs.filter((e) => e.branch === name);
        return `<span class="mrail" style="--c:${color}"><i></i><b>${esc(name)}</b>${envs.map((e) => envMini(e, color)).join('')}</span>`;
      };
      const lv = p.health.critical ? 'critical' : p.health.warning ? 'warning' : null;
      return `<a class="prow2" href="${href(p.id)}">
        <span class="pn">${esc(p.name)}${lv ? levelIcon(lv, 12) : ''}</span>
        <span class="rails2">${railHtml(t.dev, DEV)}${gapDev ? `<span class="gap" data-tip="${esc(`${gapDev} 个提交在 ${t.dev}、还没进 ${t.main}`)}">${icon.arrowRight(10)}${gapDev}</span>` : t.dev ? `<span class="gap ok" data-tip="${esc(`${t.main} 已包含 ${t.dev} 的全部提交`)}">${icon.arrowRight(10)}</span>` : ''}${railHtml(t.main, MAIN)}</span>
        <span class="pmeta">
          <span data-tip="活跃分支">${icon.branch(11)}${p.activeBranches}</span>
          <span class="avs">${p.activePeople.slice(0, 4).map((id) => avatar(p.persons[id], 18)).join('')}</span>
          <span class="muted" data-tip="${esc(p.latest ? `${p.latest.name ?? ''}：${p.latest.subject}` : '')}">${p.latest ? ago(p.latest.ctime) : ''}</span>
        </span>
      </a>`;
    });
    return `<section class="mod">
      <h2>${icon.flow(14)}<span>项目</span><span class="n">${data.projects.length}</span><span class="grow"></span><button class="icon-btn" data-add-project data-tip="添加项目">${icon.plus(13)}</button></h2>
      ${rows.join('')}
    </section>`;
  }
  function devAhead(p) {
    const i = p.stages.findIndex((s) => s.kind === 'branch' && s.name === p.trunk?.main);
    if (i <= 0) return 0;
    const g = p.gaps[i - 1];
    return g?.pending ?? 0;
  }
  function envMini(e, color) {
    const st = e.state === 'down' ? 'down' : !e.known ? 'unknown' : e.behind ? 'behind' : e.skip ? 'skip' : 'ok';
    const tip = st === 'down' ? `${e.name}连不上` : st === 'unknown' ? `${e.name}读不出版本` : st === 'behind' ? `${e.name}落后 ${e.branch} ${e.behind} 个提交` : st === 'skip' ? `${e.name}有 ${e.skip} 个提交没经过前一个环境` : `${e.name} = ${e.branch}`;
    const mark = st === 'ok' ? icon.check(9) : st === 'behind' ? `${icon.arrowDown(9)}${e.behind}` : st === 'skip' || st === 'down' ? icon.alert(9) : '?';
    return `<span class="emini ${st}" style="--c:${color}" data-tip="${esc(tip)}">${esc(e.name)}<em>${mark}</em></span>`;
  }

  /* ---------- 人：跨项目合并同一个人 ---------- */
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
      <h2>${icon.people(14)}<span>人</span><span class="n">${list.length}</span></h2>
      ${list.map((x) => `<a class="urow" href="${href(x.home.p.id, 'people', {}, x.home.id)}">
        ${avatar(x, 28)}
        <span class="un"><b>${esc(x.name)}</b><span class="muted">${ago(x.last)}</span></span>
        <span class="ub">${x.branches.sort((a, b) => b.time - a.time).slice(0, 2).map((b) => `<span class="bpill" style="--c:${branchColor(b.name)}" data-tip="${esc(`${b.p.name} · ${b.name}\n自己的提交 ${b.own} 个 · ${ago(b.time)}`)}"><i></i>${esc(short(b.name))}</span>`).join('')}${x.branches.length > 2 ? `<span class="muted" data-tip="${esc(x.branches.slice(2).map((b) => b.name).join('、'))}">+${x.branches.length - 2}</span>` : ''}</span>
        <span class="uc" data-tip="近 7 天的提交">${icon.commit(11)}${x.d7}</span>
      </a>`).join('') || '<div class="quiet">最近没有人提交</div>'}
    </section>`;
  }
  const short = (n) => (n.length > 26 ? n.slice(0, 25) + '…' : n);

  /* ---------- 本机 ---------- */
  function local() {
    const rows = [];
    for (const p of P()) {
      for (const b of p.unpushed) rows.push(`<a class="lrow2" href="${href(p.id, 'graph', { b: b.name })}" data-tip="${esc(`本机有 ${b.unpushed} 个提交没推送`)}">${projTag(p)}<span class="bpill" style="--c:${branchColor(b.name, p.trunk)}"><i></i>${esc(short(b.name))}</span><span class="warn">${icon.arrowUp(10)}${b.unpushed}</span></a>`);
      for (const c of p.dirty) rows.push(`<a class="lrow2" href="${href(p.id)}" data-tip="${esc(`${c.name}：${c.total} 个文件改了没提交`)}">${projTag(p)}<span class="muted">${icon.desktop(11)} ${esc(c.name)}</span><span class="muted">${icon.pencil(10)}${c.total}</span></a>`);
    }
    return `<section class="mod">
      <h2>${icon.desktop(14)}<span>本机</span><span class="n">${rows.length}</span></h2>
      ${(showAllLocal ? rows : rows.slice(0, 10)).join('') || `<div class="quiet">${levelIcon('good', 14)} 都推送了</div>`}
      ${rows.length > 10 ? `<button class="more" data-all-local>${showAllLocal ? icon.chevronDown(11) : icon.chevronRight(11)}<span>${showAllLocal ? '' : '+' + (rows.length - 10)}</span></button>` : ''}
    </section>`;
  }

  function draw() {
    root.innerHTML = `<div class="bcol">${issues()}${projects()}</div><div class="bcol side">${local()}${people()}</div>`;
  }

  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-add-project]')) {
      addProject?.();
      return;
    }
    if (e.target.closest('[data-info]')) {
      e.preventDefault();
      showInfo = !showInfo;
      draw();
    } else if (e.target.closest('[data-all-local]')) {
      showAllLocal = !showAllLocal;
      draw();
    }
  });

  load();
  const tick = setInterval(() => data && draw(), 60000);
  return {
    refresh() {
      clearTimeout(timer);
      timer = setTimeout(load, 800);
    },
    unmount() {
      clearTimeout(timer);
      clearInterval(tick);
    },
  };
}
