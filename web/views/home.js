// 总览：所有项目各一张卡——健康、迷你流水线、在途多少、谁最近在动、最要紧的告警。
// 点进去才看这个项目的细节（一个项目一页）。
import { esc, icon, ago, avatar, avatarStack, levelIcon, worst } from '../lib/util.js';
import { listProjects } from '../lib/api.js';
import { miniFlow, colorPersons } from '../lib/flowui.js';

export function mount(el, { href, onList }) {
  el.innerHTML = '<div class="page"><div class="page-narrow" data-root><div class="loading">正在读取项目…</div></div></div>';
  const root = el.querySelector('[data-root]');
  let data = null;
  let timer = null;

  async function load() {
    try {
      data = await listProjects();
      onList?.(data);
      draw();
    } catch (e) {
      root.innerHTML = `<div class="error-box"><b>读取失败</b><p class="t2">${esc(e.message)}</p></div>`;
    }
  }

  function draw() {
    const list = data.projects;
    const groups = new Map();
    for (const p of list) {
      const g = p.group ?? '项目';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(p);
    }
    const ready = list.filter((p) => p.ready);
    const crit = ready.filter((p) => p.health.critical).length;
    const warn = ready.filter((p) => !p.health.critical && p.health.warning).length;
    const preparing = list.filter((p) => !p.ready && p.sync?.status !== 'error').length;
    const failed = list.filter((p) => p.sync?.status === 'error').length;
    const inFlight = ready.reduce((s, p) => s + (p.inFlight ?? 0), 0);
    root.innerHTML = `
      <div class="home-h">
        <h1>项目总览</h1>
        <p>每个项目的代码走到了哪一站：分支 → dev → 测试 → main → 生产</p>
      </div>
      <div class="home-sum">
        <span class="pill"><span>${list.length} 个项目 · ${inFlight} 件在途</span></span>
        ${crit ? `<span class="pill bad">${icon.xCircle(11)}<span>${crit} 个有严重问题</span></span>` : ''}
        ${warn ? `<span class="pill warn">${icon.alert(11)}<span>${warn} 个需要注意</span></span>` : ''}
        ${!crit && !warn && ready.length ? `<span class="pill good">${icon.checkCircle(11)}<span>都正常</span></span>` : ''}
        ${preparing ? `<span class="pill">${icon.sync(11)}<span>${preparing} 个正在准备</span></span>` : ''}
        ${failed ? `<span class="pill bad">${icon.cloud(11)}<span>${failed} 个同步失败</span></span>` : ''}
      </div>
      ${[...groups].map(([g, ps]) => `<section class="section">
        <div class="sec-h"><h2>${esc(g)}</h2><span class="tag">${ps.length}</span></div>
        <div class="pcards">${ps.map(card).join('')}</div>
      </section>`).join('')}
      ${data.unmatched?.length ? `<p class="muted" style="font-size:12px">${icon.info(12)} 这些仓库没有远程地址，没算进项目：${data.unmatched.map(esc).join('、')}</p>` : ''}
      ${!list.length ? `<div class="empty">在 ${esc(data.scan.join('、'))} 下面没找到仓库。改一下 config.json 里的 scan，或者在 projects 里直接写仓库地址。</div>` : ''}`;
  }

  function card(p) {
    if (!p.ready) {
      const err = p.sync?.status === 'error';
      return `<a class="pcard pending card-hover" href="${href(p.id)}">
        <div class="top"><div style="min-width:0"><div class="pn">${esc(p.name)}</div><div class="pd">${esc(p.slug ?? p.remote)}</div></div></div>
        <div class="row muted" style="font-size:12px">${err ? `${levelIcon('critical', 13)}<span class="ell">${esc(p.sync.error ?? p.error ?? '云端副本建不起来')}</span>` : `<span class="spin" style="display:inline-grid">${icon.sync(12)}</span>正在准备云端副本…`}</div>
      </a>`;
    }
    const lv = worst(p.health);
    colorPersons(p.persons);
    const latest = p.latest;
    const state = lv === 'critical' ? `${icon.xCircle(12)}${p.health.critical} 个严重` : lv === 'warning' ? `${icon.alert(12)}${p.health.warning} 个注意` : `${icon.checkCircle(12)}正常`;
    const alerts = p.health.top.map((a) => `<span>${levelIcon(a.level, 13)}<span>${esc(a.title)}</span></span>`);
    const L = p.local;
    if (L?.unpushedBranches) alerts.push(`<span class="muted">${icon.arrowUp(13)}<span>本机 ${L.unpushedBranches} 条分支没推送${L.dirty ? ` · ${L.dirty} 个工作区有改动` : ''}</span></span>`);
    return `<a class="pcard card-hover" href="${href(p.id)}">
      <div class="top">
        <div style="min-width:0">
          <div class="pn">${esc(p.name)}${p.sync?.status === 'error' ? `<span class="pill bad" data-tip="${esc(p.sync.error ?? '')}">${icon.cloud(11)}<span>同步失败</span></span>` : ''}</div>
          <div class="pd">${esc(p.description ?? p.slug ?? '')}</div>
        </div>
        <span class="state ${lv}">${state}</span>
      </div>
      <div>${miniFlow(p)}${!p.envCount && p.stages?.length ? '<div class="faint" style="font-size:11.5px;margin-top:6px">没有配置环境：只看分支</div>' : ''}</div>
      <div class="stats">
        <span data-tip="还没走完全程的工作（按工单 / PR / 分支算）"><b>${p.inFlight}</b>在途</span>
        <span data-tip="最近 30 天内动过、还没合进主线的分支"><b>${p.activeBranches}</b>活跃分支</span>
        ${p.activePeople.length ? avatarStack(p.persons, p.activePeople, { max: 5, size: 20 }) : ''}
        ${latest ? `<span class="latest">${avatar(p.persons[latest.author], 16)}<span class="ell" style="max-width:200px" data-tip="${esc(latest.subject)}">${esc(latest.name ?? '')} · ${esc(latest.subject)}</span><span style="flex:none">${ago(latest.ctime)}</span></span>` : ''}
      </div>
      ${alerts.length ? `<div class="alerts">${alerts.join('')}</div>` : ''}
    </a>`;
  }

  // 服务端有变化：稍等一下再重读（多个项目常常一起变）
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(load, 800);
  };
  load();
  const tick = setInterval(() => data && draw(), 60000);
  return {
    refresh,
    unmount() {
      clearTimeout(timer);
      clearInterval(tick);
    },
  };
}
