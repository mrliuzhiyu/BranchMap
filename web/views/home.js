// 首页：只列项目。每个项目一行——健康、迷你流水线、在途多少、谁最近在动、最要紧的一两条告警。
// 点进去才看这个项目的细节（一个项目一页）。
import { esc, icon, ago, avatar, avatarStack, levelIcon, worst } from '../lib/util.js';
import { listProjects } from '../lib/api.js';
import { miniFlow, colorPersons } from '../lib/flowui.js';

export function mount(el, { href, onList }) {
  el.innerHTML = '<div class="page"><div class="home"><div class="loading">正在读取项目…</div></div></div>';
  const root = el.querySelector('.home');
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
    const syncing = list.filter((p) => !p.ready || p.sync?.status === 'cloning').length;
    const failed = list.filter((p) => p.sync?.status === 'error').length;
    root.innerHTML = `
      <div class="home-h">
        <div><h1>项目</h1><div class="muted" style="margin-top:4px">${list.length} 个仓库 · 一个项目一页；数据来自 BranchMap 自己的云端副本、线上环境探测和本机扫描</div></div>
        <span class="grow"></span>
        <div class="sum">
          ${crit ? `<span class="pill bad">${icon.xCircle(11)}<span>${crit} 个有严重问题</span></span>` : ''}
          ${warn ? `<span class="pill warn">${icon.alert(11)}<span>${warn} 个需要注意</span></span>` : ''}
          ${!crit && !warn && ready.length ? `<span class="pill good">${icon.checkCircle(11)}<span>都正常</span></span>` : ''}
          ${syncing ? `<span class="pill">${icon.sync(11)}<span>${syncing} 个正在准备</span></span>` : ''}
          ${failed ? `<span class="pill bad">${icon.cloud(11)}<span>${failed} 个同步失败</span></span>` : ''}
        </div>
      </div>
      ${[...groups].map(([g, ps]) => `<section class="hgroup"><h2>${esc(g)}<span class="faint" style="font-weight:400">${ps.length}</span></h2>${ps.map(card).join('')}</section>`).join('')}
      ${data.unmatched?.length ? `<p class="muted" style="margin-top:28px;font-size:12px">${icon.info(12)} 这些仓库没有远程地址，没算进项目：${data.unmatched.map(esc).join('、')}</p>` : ''}
      ${!list.length ? `<div class="empty">在 ${esc(data.scan.join('、'))} 下面没找到仓库。改一下 config.json 里的 scan，或者在 projects 里直接写仓库地址。</div>` : ''}`;
  }

  function card(p) {
    if (!p.ready) {
      const err = p.sync?.status === 'error';
      return `<a class="pcard pending${err ? ' critical' : ''}" href="${href(p.id)}">
        <div><div class="pn">${esc(p.name)}</div><div class="pd">${p.slug ? esc(p.slug) : esc(p.remote)}</div></div>
        <div class="row muted">${err ? `${levelIcon('critical')}<span class="ell">${esc(p.sync.error ?? p.error ?? '云端副本建不起来')}</span>` : `<span class="spin" style="display:inline-grid">${icon.sync(13)}</span>正在准备云端副本…`}</div>
        <div></div></a>`;
    }
    const lv = worst(p.health);
    colorPersons(p.persons);
    const latest = p.latest;
    const alerts = p.health.top;
    const L = p.local;
    const localBits = [];
    if (L?.unpushedBranches) localBits.push(`<span>${icon.arrowUp(12)}本机 ${L.unpushedBranches} 条分支没推送</span>`);
    if (L?.dirty) localBits.push(`<span class="muted">${icon.pencil(12)}${L.dirty} 个工作区有改动</span>`);
    return `<a class="pcard ${lv}" href="${href(p.id)}">
      <div style="min-width:0">
        <div class="pn">${esc(p.name)}${p.sync?.status === 'error' ? `<span class="pill bad" data-tip="${esc(p.sync.error ?? '')}">${icon.cloud(11)}<span>同步失败</span></span>` : ''}</div>
        <div class="pd"><span class="ell">${esc(p.description ?? p.slug ?? '')}</span></div>
      </div>
      <div style="min-width:0">${miniFlow(p)}${!p.envCount && p.stages?.length ? `<div class="faint" style="font-size:11.5px;margin-top:6px">没有配置环境：只看分支。在 config.json 里给它加 environments 就能看到线上跑的版本</div>` : ''}</div>
      <div class="pstats">
        <div class="row" style="gap:14px">
          <span class="kv-inline" data-tip="还没走完全程的工作（按工单 / PR / 分支算）"><b>${p.inFlight}</b>在途</span>
          <span class="kv-inline" data-tip="最近 30 天内动过、还没合进主线的分支"><b>${p.activeBranches}</b>活跃分支</span>
          ${p.activePeople.length ? avatarStack(p.persons, p.activePeople, { max: 5, size: 20 }) : ''}
        </div>
        ${latest ? `<div class="row muted" style="font-size:12px;max-width:100%">${avatar(p.persons[latest.author], 16)}<span class="ell" style="max-width:240px" data-tip="${esc(latest.subject)}">${esc(latest.name ?? '')} · ${esc(latest.subject)}</span><span style="flex:none">${ago(latest.ctime)}</span></div>` : ''}
      </div>
      ${alerts.length || localBits.length ? `<div class="alerts">${alerts.map((a) => `<span>${levelIcon(a.level, 13)}${esc(a.title)}</span>`).join('')}${localBits.join('')}</div>` : ''}
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
