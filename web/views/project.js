// 分支图：一个项目的全部，一层一层往下看。
//   左：main / dev 两条主线（带「生产」「测试」这类环境标签，可以加）+ 按人列出的分支，颜色和图上一致
//   中：提交图，两种看法：
//     完整（默认）：原样的 git 提交图，main 在最左（合并完的历史也画出来，颜色按来源分支、画得淡）
//     主线：main、dev 两条并行线贯穿全图（main 在左）。实线 = 这条分支已经有这一行的改动，虚线 = 还没有；
//                  两线之间的连线 = 发布（dev → main）或回合（main → dev）；合进来的功能分支收成一行「合并 xxx · N 个提交」；
//                  还没合进去的分支画在右边，各自一种颜色，连到它分出来的地方。
//   右：第二层——点分支：它是谁的、走到哪了、它自己的提交；第三层——点提交：走到哪了、改了哪些文件（可返回分支）
// 能用图形表达的就不写字；解释都放在悬停提示里。
import { esc, icon, avatar, ago, when, fullStamp, toast, copyText, closePop, debounce, lineStat, fileName, prChip, picker, tipCard } from '../lib/util.js';
import { layout, segPath, TRUNKS } from '../lib/layout.js';
import { openChanges } from '../lib/changes.js';
import { commitChangesLoader } from '../lib/commitview.js';
import { has } from '../lib/model.js';
import { MAIN, DEV, HIST, branchColor } from '../lib/colors.js';
import { openSettings } from '../lib/settings.js';
import { resizer } from '../lib/resize.js';
import { fitMid } from '../lib/measure.js';

const RH = 30;
const LW = 14;
const PAD = 14;
const MAX_LANES = 10; // 更多的泳道收进最右一条，给提交说明留位置
const OVERSCAN = 12;
const RECENT_MERGED = 7 * 86400;

/** 合并说明里的来源、目标分支和其余文字：认得 GitHub PR、git 默认说明、「Merge origin/dev into x」、中文「合并：dev 进 main」。 */
function mergeNames(s) {
  const clean = (n) => n?.replace(/^(origin|upstream)\//, '') ?? null;
  let m = /^Merge pull request #\d+ from [^/\s]+\/(\S+)\s*(.*)$/s.exec(s);
  if (m) return { from: m[1], into: null, rest: m[2].trim() };
  m = /^Merge (?:remote-tracking )?branch '([^']+)'(?: of \S+)?(?: into (\S+))?\s*(.*)$/s.exec(s);
  if (m) return { from: clean(m[1]), into: clean(m[2]), rest: m[3].trim() };
  m = /^Merge (\S+) into (\S+)\s*[:：]?\s*(.*)$/s.exec(s);
  if (m) return { from: clean(m[1]), into: clean(m[2]), rest: m[3].trim() };
  m = /^合并\s*[:：]\s*(\S+?)\s*(?:进|到|合入|→|->)\s*([^\s（(，,]+)\s*(.*)$/s.exec(s);
  if (m) return { from: clean(m[1]), into: clean(m[2]), rest: m[3].replace(/^[（(]|[）)]$/g, '').trim() || s };
  return { from: null, into: null, rest: s };
}

/**
 * 图上显示哪些分支，按项目记在浏览器里：
 *   pinned  顶部栏里挑了的分支（null = 还没挑过，默认显示全部进行中的分支）
 *   history 完整视图里是否画已合并的历史；view 完整（默认）/ 主线
 */
function loadHidden(id) {
  try {
    const v = JSON.parse(localStorage.getItem('bm-hidden:' + id) ?? 'null');
    return { pinned: Array.isArray(v?.pinned) ? new Set(v.pinned) : null, history: v?.history ?? true, mode: v?.view === 'trunk' ? 'trunk' : 'full' };
  } catch {
    return { pinned: null, history: true, mode: 'full' };
  }
}
function saveHidden(id, h) {
  try {
    localStorage.setItem('bm-hidden:' + id, JSON.stringify({ pinned: h.pinned ? [...h.pinned] : null, history: h.history, view: h.mode }));
  } catch { /* 无痕模式 */ }
}

export function mount(el, ctx) {
  const { store } = ctx;
  let M = store.model;
  let O = ctx.overview;
  const S = {
    sel: ctx.params.get('c') || null,
    branch: ctx.params.get('b') || null,
    who: ctx.params.has('who') ? Number(ctx.params.get('who')) : null,
    q: ctx.params.get('q') || '',
    env: ctx.params.get('env') || null, // 右边打开的环境
    tab: ctx.params.get('t') || null, // 主线详情的标签页：ahead 待上线 / behind 没回合 / log 最近
  };
  const H = loadHidden(ctx.id); // 顶部开关：隐藏了哪些分支、是否显示已合并的历史
  let V = null;
  let C = null;
  let selRow = -1;
  let painted = { first: -1, last: -1 };
  let detailToken = 0;

  el.innerHTML = `<div class="ws">
    <aside class="lcol" data-l></aside>
    <section class="gcol">
      <div class="gbar" data-bar></div>
      <div class="ghead" data-head></div>
      <div class="glist" tabindex="0"><div class="gbody"></div></div>
      <i class="rz-msg"></i>
    </section>
    <aside class="dcol" data-d hidden></aside>
    <i class="rz-l"></i><i class="rz-d"></i>
  </div>`;
  const L = el.querySelector('[data-l]');
  const bar = el.querySelector('[data-bar]');
  const list = el.querySelector('.glist');
  const body = el.querySelector('.gbody');
  const D = el.querySelector('[data-d]');
  const head = el.querySelector('[data-head]');
  const gcol = el.querySelector('.gcol');
  // 可拖：左栏宽、右侧详情宽、提交说明那一列宽（头像和时间紧跟在说明后面）；宽度记在浏览器里，双击恢复
  const ws = el.querySelector('.ws');
  resizer(el.querySelector('.rz-l'), { target: ws, prop: '--lw', key: 'graph-left', min: 180, max: () => Math.min(520, innerWidth * 0.28), dir: 1, def: 240, onChange: () => fitChips() });
  resizer(el.querySelector('.rz-d'), { target: ws, prop: '--dw', key: 'graph-detail', min: 300, max: () => Math.min(760, innerWidth * (innerWidth <= 1200 ? 0.7 : 0.4)), dir: -1, def: 360, onChange: () => fitChips() });
  resizer(el.querySelector('.rz-msg'), { target: gcol, prop: '--gm', key: 'graph-message', min: 200, max: () => Math.max(240, list.clientWidth - (V?.gw ?? 60) - 140), dir: 1, def: 520, onChange: () => placeMsgHandle() });
  /** 说明列的拖动柄：从表头下面开始（工具条、主线表头的高度会变），横向对准头像列前面的实际分界（说明列可能被挤窄） */
  function placeMsgHandle() {
    const h = gcol.querySelector('.rz-msg');
    if (!h) return;
    h.style.top = bar.offsetHeight + (head.hidden ? 0 : head.offsetHeight) + 'px';
    const ga = body.querySelector('.gr .ga');
    if (ga) h.style.left = ga.getBoundingClientRect().left - gcol.getBoundingClientRect().left - 9 + 'px';
  }

  /* ================= 数据：主线、每条分支的颜色、每个提交归谁 ================= */
  function prepare() {
    M = store.model;
    O = ctx.overview;
    const mainName = M.trunk.prod;
    const devName = M.trunk.dev;
    const mainTip = mainName ? M.branches.get(mainName)?.tip ?? -1 : -1;
    const devTip = devName ? M.branches.get(devName)?.tip ?? -1 : -1;
    const now = Date.now() / 1000;
    const rows = (O.branches ?? []).filter((b) => M.branches.has(b.name));
    // 列出来的分支：还在做的 + 最近 7 天合进去的；停滞的折叠
    const show = rows.filter((b) => b.status === 'active' || ((b.status === 'merged' || b.status === 'released') && now - b.time < RECENT_MERGED));
    const stale = rows.filter((b) => b.status === 'stale');
    const colorOf = new Map([['main', MAIN], ['dev', DEV], ['hist', HIST], ['wip', 'var(--muted)']]);
    for (const b of [...show, ...stale]) colorOf.set('b:' + b.name, branchColor(b.name));

    // 每个提交归谁：main 第一父链 → main；dev 第一父链 → dev；没合进主线的分支提交 → 那条分支；其余是合并完的历史
    const key = new Array(M.N).fill('hist');
    const mainChain = new Set();
    for (let c = mainTip; c !== undefined && c >= 0; c = M.P[c][0]) mainChain.add(c);
    for (let c = devTip; c !== undefined && c >= 0 && !mainChain.has(c); c = M.P[c][0]) key[c] = 'dev';
    for (const c of mainChain) key[c] = 'main';
    const trunkSet = M.union([mainTip, devTip].filter((x) => x >= 0));
    const owned = new Map();
    for (const b of [...show, ...stale].sort((x, y) => y.time - x.time)) {
      const mine = [];
      const st = [M.branches.get(b.name).tip];
      while (st.length) {
        const c = st.pop();
        if (c < 0 || has(trunkSet, c) || key[c] !== 'hist') continue;
        key[c] = 'b:' + b.name;
        mine.push(c);
        for (const p of M.P[c]) st.push(p);
      }
      owned.set(b.name, mine);
    }
    // 已经合并完的历史（同事们的分支合进主线的路线）：每个提交归到把它合进来的那条分支，和进行中的分支一样用它的颜色画清楚。
    //   1. 所有认得出来源的合并（PR、合并说明），从旧到新：它带进来、还没归属的提交归给来源分支——里层的分支先认领，
    //      所以「PR 合进某人本地 dev、再 pull 合进 dev」这种套娃，提交仍然算在 PR 的分支上
    //   2. 剩下的看它是被主线上哪个合并带进来的：来源是主线自己（git pull 产生的）就是「dev 的并行提交」，画主线的颜色；
    //      否则按写代码的人算「某某的提交」。不再有意义不明的灰色
    const trunkColors = { main: mainName, dev: devName };
    const merged = new Map(); // 显示名 -> 提交数
    const mergedTip = new Map(); // 被合进来的那条线最新的提交 -> { name, into }（图上在这里标出名字）
    const assign = (c, n) => {
      key[c] = 'h:' + n;
      merged.set(n, (merged.get(n) ?? 0) + 1);
      if (!colorOf.has('h:' + n)) colorOf.set('h:' + n, branchColor(n, trunkColors));
    };
    const isTrunkName = (n) => n === mainName || n === devName;
    for (let x = M.N - 1; x >= 0; x--) {
      if (M.P[x].length < 2) continue;
      const pr = M.prByMerge?.get(M.h[x]);
      const mm = mergeNames(M.s[x]);
      const src = pr?.head ?? mm.from;
      if (!src || isTrunkName(src)) continue;
      const A = M.anc(M.P[x][1]);
      const B = M.anc(M.P[x][0]);
      let took = false;
      for (let w = 0; w < A.length; w++) {
        let bits = A[w] & ~B[w];
        while (bits) {
          const b = 31 - Math.clz32(bits);
          bits &= ~(1 << b);
          const c = w * 32 + b;
          if (key[c] !== 'hist') continue;
          assign(c, src);
          took = true;
        }
      }
      if (took && !mergedTip.has(M.P[x][1])) mergedTip.set(M.P[x][1], { name: src, into: pr?.base ?? mm.into ?? '主线' });
    }
    for (const tip of [devTip, mainTip]) {
      if (tip < 0) continue;
      const T = M.trunkInfo(tip);
      const into = tip === devTip ? devName : mainName;
      for (let c = 0; c < M.N; c++) {
        if (key[c] !== 'hist' || T.intro[c] < 0) continue;
        const m = T.chain[T.intro[c]];
        if (M.P[m].length < 2) continue;
        // 认不出分支名的（包括 git pull 产生的并行提交）：按写代码的人上色，一眼看出是谁的
        const src = mergeNames(M.s[m]).from;
        const n = '@' + (M.person(M.a[c])?.name ?? '?');
        assign(c, n);
        if (!mergedTip.has(M.P[m][1])) mergedTip.set(M.P[m][1], { name: n, into, direct: isTrunkName(src) ? src : null });
      }
    }

    // 环境标签：挂在它运行的提交上（没探测到的挂在分支最新提交上，标成假定）
    const envs = (M.raw.envs ?? []).map((e) => ({ ...e, c: e.commit ? M.byHash.get(e.commit) ?? -1 : -1 }));
    const envAt = new Map();
    for (const e of envs) {
      if (e.c < 0) continue;
      if (!envAt.has(e.c)) envAt.set(e.c, []);
      envAt.get(e.c).push(e);
    }
    C = { mainName, devName, mainTip, devTip, key, colorOf, show, stale, owned, envs, envAt, trunkSet, merged, mergedTip };
    mcCache.clear();
  }
  const colorFor = (k) => C.colorOf.get(k) ?? 'var(--hist)';
  const keyOfBranch = (name) => (name === C.mainName ? 'main' : name === C.devName ? 'dev' : 'b:' + name);

  /**
   * 点一条分支时点亮哪些提交（其余压暗）：
   *   主线（dev / main）：整条第一父链；
   *   分支：还没合进去的（b:名字）+ 从它合进来的（h:名字）+ 它自己那条线上最近的一段
   *   （从最新提交沿第一父往下，到上一次合并、或第一个不是负责人写的提交为止——快进合并后这些提交记在主线上）。
   *   不会出现整张图全暗。
   * 返回 { ids: 点亮的提交, keys: 这些提交的颜色 key（对应的连线也不压暗） }
   */
  function branchFocus(name) {
    const k = keyOfBranch(name);
    const tip = M.branches.get(name)?.tip ?? -1;
    const ids = new Set();
    if (tip >= 0 && TRUNKS.has(k)) {
      for (let c = tip; c !== undefined && c >= 0; c = M.P[c][0]) ids.add(c);
    } else if (tip >= 0) {
      for (let c = 0; c < M.N; c++) if (C.key[c] === k || C.key[c] === 'h:' + name) ids.add(c);
      // 再加上它自己那条线上、比上一次合并更新的提交（快进合并后这些提交记在主线上，git 里认不出来源）
      let floor = 0;
      for (const c of ids) floor = Math.max(floor, M.t[c]);
      const owner = O.branches.find((b) => b.name === name)?.owner ?? M.a[tip];
      for (let c = tip; c !== undefined && c >= 0; c = M.P[c][0]) {
        if (c !== tip && (ids.has(c) || M.a[c] !== owner || M.t[c] <= floor)) break;
        ids.add(c);
      }
    }
    const keys = new Set([k]);
    for (const c of ids) keys.add(C.key[c]);
    return { ids, keys };
  }
  const railOf = (e) => (e.branch === C.mainName ? 'main' : e.branch === C.devName ? 'dev' : null);

  /** 走到哪了：dev → 测试 → main → 生产（有几站画几个点） */
  function stops() {
    const out = [];
    const add = (name, k, tip, env = false) => tip >= 0 && out.push({ name, k, tip, env });
    add(C.devName, 'dev', C.devTip);
    for (const e of C.envs.filter((x) => x.branch === C.devName && x.c >= 0 && !x.assumed)) add(e.name, 'dev', e.c, true);
    add(C.mainName, 'main', C.mainTip);
    for (const e of C.envs.filter((x) => x.branch === C.mainName && x.c >= 0 && !x.assumed)) add(e.name, 'main', e.c, true);
    return out;
  }
  function journey(c) {
    const st = stops();
    const card = tipCard({ title: '走到哪了', dots: st.map((s) => ({ on: M.isAncestor(c, s.tip), c: colorFor(s.k), env: s.env, label: `${s.env ? '环境 ' : ''}${s.name}${M.isAncestor(c, s.tip) ? '' : '（还没有）'}` })) });
    return `<span class="jy" data-tip-html data-tip="${esc(card)}">${st.map((s) => `<i class="${M.isAncestor(c, s.tip) ? 'on' : ''}${s.env ? ' e' : ''}" style="--c:${colorFor(s.k)}"></i>`).join('')}</span>`;
  }
  function stepsHtml(c) {
    const st = stops();
    if (!st.length) return '';
    return `<div class="steps">${st.map((s) => {
      const on = M.isAncestor(c, s.tip);
      const tip = s.env ? `环境「${s.name}」：${on ? '已经部署了这个提交' : '还没部署到这里'}` : `分支 ${s.name}：${on ? '已经合进来了' : '还没合进来'}`;
      return `<div class="step${on ? ' on' : ''}${s.env ? ' is-env' : ''}" style="--c:${colorFor(s.k)}" data-tip-c="${colorFor(s.k)}" data-tip="${esc(tip)}"><i>${s.env ? icon.server(8) : ''}</i><span>${esc(s.name)}</span></div>`;
    }).join('<b class="stepl"></b>')}</div>`;
  }

  function envPill(e, k, editable = false) {
    const color = colorFor(k ?? railOf(e) ?? 'hist');
    const tip = [
      e.assumed ? (e.probe ? `${e.name}：读不出运行的版本，暂按 ${e.branch} 最新提交显示` : `${e.name}：没填探测地址，按 ${e.branch} 最新提交显示`) : `${e.name}正在运行这个提交${e.version ? `（版本 ${e.version}）` : ''}`,
      e.assumed && e.detail ? e.detail : '',
      e.probe ? `探测：${e.probe}` : '',
      '点击看环境详情：待部署、发布清单、上线记录',
    ].filter(Boolean).join('\n');
    return `<span class="env${e.assumed ? ' assumed' : ''}${e.state === 'down' ? ' down' : ''}" style="--c:${color}" data-env="${esc(e.id)}" data-tip-c="${color}" data-tip="${esc(tip)}">${icon.server(9)}${esc(e.name)}</span>`;
  }

  /* ================= 左栏：主线 + 按人的分支 ================= */
  function drawLeft() {
    const persons = O.persons;
    const localBy = new Map((O.local?.branches ?? []).map((b) => [b.name, b]));
    const loc = (lb) => `${lb?.unpushed > 0 ? `<span class="loc" data-tip="${esc(`本机有 ${lb.unpushed} 个提交没推送`)}">${icon.desktop(10)}${icon.arrowUp(10)}${lb.unpushed}</span>` : ''}${lb?.behind > 0 ? `<span class="loc dim" data-tip="${esc(`本机落后云端 ${lb.behind} 个提交（没拉取）`)}">${icon.desktop(10)}${icon.arrowDown(10)}${lb.behind}</span>` : ''}`;

    const rail = (name, k, tip) => {
      if (!name || tip < 0) return '';
      let gap = '';
      // 两条主线互相差多少（和看板、健康提示同一个数：不算合并提交），点了打开对应标签页
      const T = O.trunk;
      if (T && name === T.dev && T.ahead.count) gap = `<span class="gap go" data-trunk-tab="ahead" data-tip="${esc(`待上线：${T.ahead.count} 个提交在 ${T.dev}、还没进 ${T.main}`)}">${icon.arrowRight(10)}${T.ahead.count}</span>`;
      if (T && name === T.main && T.behind.count) gap = `<span class="gap go warn" data-trunk-tab="behind" data-tip="${esc(`没回合：${T.main} 上有 ${T.behind.count} 个提交不在 ${T.dev}`)}">${icon.arrowLeft(10)}${T.behind.count}</span>`;
      return `<div class="rail-row${S.branch === name ? ' on' : ''}" data-branch="${esc(name)}" style="--c:${colorFor(k)}" data-tip-c="${colorFor(k)}" data-tip="${esc(`${name}\n${k === 'main' ? '上线分支' : '集成分支'}\n点击看它的详情`)}">
        <i class="rbar"></i><span class="rname">${esc(name)}</span>
        ${C.envs.filter((e) => e.branch === name).map((e) => envPill(e, k, true)).join('')}
        <button class="add" data-add-label="${esc(name)}" data-tip="加环境标签">${icon.tag(12)}</button>
        <span class="grow"></span>${loc(localBy.get(name))}${gap}
      </div>`;
    };
    const branchTip = (b) => {
      const p = persons[b.owner];
      const lb = localBy.get(b.name);
      const base = C.devName ?? C.mainName;
      const status = { active: '进行中', merged: `已进 ${C.devName ?? ''}，等上线`, released: `已进 ${C.mainName ?? ''}`, stale: '停滞' }[b.status] ?? '';
      return tipCard({
        c: colorFor('b:' + b.name),
        title: b.name,
        sub: `${avatar(p, 16)}<span>${esc(p?.name ?? '?')}</span><span>·</span><span>${esc(ago(b.time))}</span>`,
        rows: [
          ['状态', esc(status)],
          ['提交', `<span class="up">+${b.own}</span>${b.behind != null && base ? `<span class="down">落后 ${esc(base)} ${b.behind}</span>` : ''}`],
          b.pr ? ['PR', `#${b.pr.n} ${esc(b.pr.title ?? '')}`] : null,
          lb && (lb.unpushed > 0 || lb.behind > 0) ? ['本机', `${lb.unpushed > 0 ? `<span class="warn">${lb.unpushed} 个没推送</span>` : ''}${lb.behind > 0 ? `<span>${lb.behind} 个没拉取</span>` : ''}`] : null,
        ].filter(Boolean),
        hint: '点击看详情',
      });
    };
    const branchRow = (b) => {
      const tip = M.branches.get(b.name).tip;
      const merged = b.status === 'merged' || b.status === 'released';
      return `<div class="br-row${S.branch === b.name ? ' on' : ''}${merged ? ' merged' : ''}" data-branch="${esc(b.name)}" style="--c:${colorFor('b:' + b.name)}" data-tip-html data-tip="${esc(branchTip(b))}">
        <i class="dot"></i><span class="bname" data-mid="${esc(b.name)}">${esc(b.name)}</span>${b.pr ? prChip(b.pr, { mini: true }) : ''}${(O.branchTags?.[b.name] ?? []).slice(0, 2).map((t) => `<span class="utag sm">${esc(t)}</span>`).join('')}${loc(localBy.get(b.name))}
        ${merged ? journey(tip) : `<span class="own" data-tip="自己的提交">+${b.own}</span>`}
        ${merged ? '' : `<button class="eye${pins().has(b.name) ? ' on' : ''}" data-pin-toggle="${esc(b.name)}" data-tip="${pins().has(b.name) ? '在图上：点一下去掉' : '画到图上（加进顶部栏）'}">${icon.eye(12)}</button>`}
      </div>`;
    };
    const byPerson = new Map();
    for (const b of C.show) {
      if (!byPerson.has(b.owner)) byPerson.set(b.owner, []);
      byPerson.get(b.owner).push(b);
    }
    const groups = [...byPerson].sort((x, y) => Math.max(...y[1].map((b) => b.time)) - Math.max(...x[1].map((b) => b.time)));
    const staleOpen = L.dataset.stale === '1';
    L.innerHTML = `
      <div class="rails">${rail(C.mainName, 'main', C.mainTip)}${rail(C.devName, 'dev', C.devTip)}</div>
      <div class="people">
        ${groups.map(([pid, bs]) => {
          const p = persons[pid];
          return `<div class="pgroup">
            <button class="p-row${S.who === pid ? ' on' : ''}" data-who="${pid}" data-tip="${esc(`只看 ${p?.name ?? ''} 的提交`)}">${avatar(p, 18)}<span>${esc(p?.name ?? '?')}</span></button>
            ${bs.sort((x, y) => y.time - x.time).map(branchRow).join('')}
          </div>`;
        }).join('') || `<div class="quiet">${icon.check(12)} 没有进行中的分支</div>`}
        ${C.stale.length ? `<button class="more" data-stale-toggle data-tip="超过 ${O.staleDays} 天没动、也没合进主线">${staleOpen ? icon.chevronDown(11) : icon.chevronRight(11)}${icon.clock(11)}<span>${C.stale.length}</span></button>${staleOpen ? C.stale.map(branchRow).join('') : ''}` : ''}
      </div>`;
  }

  /* ================= 中间：提交图 ================= */
  function drawBar() {
    const chip = S.branch
      ? `<i class="dot" style="background:${colorFor(keyOfBranch(S.branch))}"></i><span data-mid="${esc(S.branch)}">${esc(S.branch)}</span>`
      : S.who != null ? `${avatar(O.persons[S.who], 16)}${esc(O.persons[S.who]?.name ?? '')}` : '';
    // 顶部栏 = 图上画哪些分支：主线一直在（点一下看详情）；其余分支按需用「+」加进来，× 去掉
    const trunkChip = (name, k) => (name ? `<button class="bchip trunk" data-branch-focus="${esc(name)}" style="--c:${colorFor(k)}" data-tip-c="${colorFor(k)}" data-tip="${esc(`${name}\n主线，一直显示\n点一下看它的详情`)}"><i></i>${esc(name)}</button>` : '');
    const byName = new Map([...C.show, ...C.stale].map((b) => [b.name, b]));
    const chips = [...pins()].filter((n) => byName.has(n)).map((n) => {
      const b = byName.get(n);
      return `<span class="bchip pin${S.branch === n ? ' on' : ''}" data-branch-focus="${esc(n)}" style="--c:${colorFor('b:' + n)}" data-tip-c="${colorFor('b:' + n)}" data-tip="${esc(`${n}\n${O.persons[b.owner]?.name ?? ''} · ${ago(b.time)}\n点一下看详情`)}"><i></i><span class="nm" data-mid="${esc(n)}">${esc(n)}</span><button class="unpin" data-unpin="${esc(n)}" data-tip="从图上去掉">${icon.close(10)}</button></span>`;
    }).join('');
    const mergedN = [...C.merged.values()].reduce((a, b) => a + b, 0);
    const trunkMode = H.mode !== 'full';
    bar.innerHTML = `
      <div class="gmode" data-tip="完整：原样的 git 提交图\n主线：只看 main、dev 两条线和还没合进去的分支"><button data-mode="full" aria-pressed="${!trunkMode}">完整</button><button data-mode="trunk" aria-pressed="${trunkMode}">主线</button></div>
      <label class="gsearch" data-tip="搜提交说明、哈希、作者（回车跳到下一个）">${icon.search(13)}<input data-q value="${esc(S.q)}" placeholder="搜索" autocomplete="off"><span class="count" data-qcount></span></label>
      ${chip ? `<button class="chipx" data-clear data-tip="取消筛选">${chip}${icon.close(11)}</button>` : ''}
      <div class="bchips" data-chips>
        ${trunkChip(C.mainName, 'main')}${trunkChip(C.devName, 'dev')}
        ${chips ? `<span class="bsep"></span>${chips}` : ''}
      </div>
      ${C.show.length + C.stale.length ? '<button class="bchip bmore" data-more-branches data-pop-anchor></button>' : ''}
      ${S.branch && !pins().has(S.branch) && !TRUNKS.has(keyOfBranch(S.branch)) ? `<button class="bchip addcur" data-pin="${esc(S.branch)}" data-tip="把正在看的这条分支固定到图上">${icon.plus(11)}固定</button>` : ''}
      ${trunkMode ? '' : `<span class="bsep"></span>
      <button class="bchip hist${H.history ? '' : ' off'}" data-toggle-history data-tip="${esc(`已经合并完的历史（${C.merged.size} 条分支、${mergedN} 个提交），颜色按来源分支、画得淡一些\n点一下${H.history ? '隐藏' : '显示'}`)}"><i></i>已合并</button>`}`;
    fitChips();
  }

  /** 分支多了一行放不下：放得下几个就平铺几个，其余收进「+N」；没收起时按钮上是分支总数。点开都是同一个勾选面板。 */
  function fitChips() {
    const box = bar.querySelector('[data-chips]');
    const more = bar.querySelector('[data-more-branches]');
    if (!box || !more) return;
    const chips = [...box.querySelectorAll('.bchip.pin')];
    const sep = box.querySelector('.bsep');
    for (const c of chips) c.hidden = false;
    if (sep) sep.hidden = false;
    fitMid(box); // 名字先按中间省略截好，下面量到的才是最终宽度
    // 一次读完每个分支的右边缘，算出前几个放得下（不在循环里反复读 scrollWidth，每读一次都要重排）；两条主线永远在
    const left = box.getBoundingClientRect().left;
    const rights = chips.map((c) => c.getBoundingClientRect().right - left);
    const fit = (w) => {
      const n = rights.findIndex((r) => r > w + 1);
      return n < 0 ? chips.length : n;
    };
    const setMore = (folded) => {
      more.classList.toggle('folded', folded > 0);
      more.innerHTML = folded ? `${icon.plus(11)}<span>${folded}</span>` : chips.length ? icon.plus(12) : `${icon.plus(11)}<span>添加分支</span>`;
    };
    let kept = fit(box.clientWidth);
    setMore(chips.length - kept);
    // 「+N」按钮变宽会把这一栏挤窄一点：再算一次
    const w2 = box.clientWidth;
    if (fit(w2) < kept) setMore(chips.length - (kept = fit(w2)));
    chips.forEach((c, i) => { c.hidden = i >= kept; });
    const folded = chips.length - kept;
    if (sep && chips.length && folded === chips.length) sep.hidden = true;
    const total = C.show.length + C.stale.length;
    more.dataset.tip = [folded ? `还有 ${folded} 条加了的分支没放下` : '', `从 ${total} 条分支里挑要画在图上的`, '左栏分支旁的眼睛也能加'].filter(Boolean).join('\n');
  }

  /** 图上画的分支：挑过就按挑的；没挑过默认是全部进行中的分支。正在看的那条分支临时也画。 */
  function pins() {
    if (H.pinned) return H.pinned;
    return new Set(C.show.filter((b) => b.status === 'active').map((b) => b.name)); // 默认：全部进行中的分支
  }
  const drawn = (name) => pins().has(name) || S.branch === name;
  function setPinned(name, on) {
    const next = new Set(pins());
    on ? next.add(name) : next.delete(name);
    H.pinned = next;
    drawLeft();
    applyHidden();
  }

  /** 全部分支的勾选面板：按人分组、可搜索，勾上 = 在图上显示；停滞的分支单独一组放最后。 */
  function openBranchPanel(anchor) {
    const persons = O.persons;
    const groups = new Map();
    for (const b of C.show) {
      const g = persons[b.owner]?.name ?? '?';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(b);
    }
    const ordered = [...groups].sort((x, y) => Math.max(...y[1].map((b) => b.time)) - Math.max(...x[1].map((b) => b.time)));
    if (C.stale.length) ordered.push([`停滞（${O.staleDays} 天没动）`, [...C.stale]]);
    const all = ordered.flatMap(([, bs]) => bs.map((b) => b.name));
    const items = ordered.flatMap(([g, bs]) => bs.sort((x, y) => y.time - x.time).map((b) => ({
      value: b.name,
      label: `${b.name} ${persons[b.owner]?.name ?? ''}`, // 只用来搜索：分组标题里已经有人名了
      group: g,
      html: `<i class="dot" style="background:${colorFor('b:' + b.name)}"></i><span class="ell mono">${esc(b.name)}</span><span class="faint" style="margin-left:auto;font-size:11px;flex:none">${ago(b.time)}</span>`,
    })));
    const me = ctx.me?.();
    const pop = picker(anchor, {
      items,
      multi: true,
      selected: all.filter((n) => pins().has(n)),
      placeholder: '搜分支或成员，勾上的画在图上',
      width: 340,
      footer: `<button class="btn sm ghost" data-all-active>全部进行中</button>${me != null ? '<button class="btn sm ghost" data-mine>只看我的</button>' : ''}<button class="btn sm ghost" data-clear>清空</button><span class="grow"></span><button class="btn sm" data-done>完成</button>`,
      onPick: (sel) => {
        H.pinned = new Set(sel);
        drawLeft();
        applyHidden();
      },
    });
    const reset = (set) => {
      H.pinned = set; // null = 默认：全部进行中的分支（以后新开的分支也自动画上）
      drawLeft();
      applyHidden();
      openBranchPanel(bar.querySelector('[data-more-branches]') ?? anchor);
    };
    pop.querySelector('[data-all-active]').addEventListener('click', () => reset(null));
    pop.querySelector('[data-mine]')?.addEventListener('click', () => reset(new Set(C.show.filter((b) => b.status === 'active' && b.owner === me).map((b) => b.name))));
  }

  /** 显示 / 隐藏改了：记住选择，重排提交图，尽量停在原来看的位置。 */
  function applyHidden() {
    saveHidden(ctx.id, H);
    const anchor = V.order[Math.floor(list.scrollTop / RH)];
    drawBar();
    compute();
    const r = V.rowOf.get(anchor);
    if (r !== undefined) list.scrollTop = r * RH;
    const id = S.sel ? M.byHash.get(S.sel) : undefined;
    selRow = id !== undefined ? V.rowOf.get(id) ?? -1 : -1;
    paint(true);
  }

  function wipNodes() {
    const out = [];
    for (const w of store.wtState ?? []) {
      if (w.temp || !w.total) continue;
      const c = M.worktrees.find((x) => x.path === w.path)?.c ?? -1;
      if (c >= 0) out.push({ id: M.N + out.length, c, w });
    }
    return out;
  }

  /** 这个提交在图上显示吗：主线一直显示；分支看顶部开关；已合并的历史看「已合并」开关。 */
  function shown(c) {
    const k = C.key[c];
    if (k === 'main' || k === 'dev') return true;
    if (k.startsWith('b:')) return drawn(k.slice(2));
    return H.history;
  }

  function compute() {
    if (H.mode !== 'full') return computeTrunk();
    const wips = wipNodes();
    const wipAt = new Map();
    for (const x of wips) {
      if (!wipAt.has(x.c)) wipAt.set(x.c, []);
      wipAt.get(x.c).push(x.id);
    }
    const order = [];
    for (let i = 0; i < M.N; i++) {
      if (!shown(i)) continue;
      const w = wipAt.get(i);
      if (w) order.push(...w);
      order.push(i);
    }
    const rowOf = new Map(order.map((id, r) => [id, r]));
    const pin = new Map();
    for (let c = C.mainTip; c !== undefined && c >= 0; c = M.P[c][0]) if (rowOf.has(c)) pin.set(c, 0);
    for (let c = C.devTip; c !== undefined && c >= 0 && !pin.has(c); c = M.P[c][0]) if (rowOf.has(c)) pin.set(c, 1);
    const rails = new Map();
    if (rowOf.has(C.mainTip)) rails.set(0, { start: rowOf.get(C.mainTip), key: 'main' });
    if (rowOf.has(C.devTip)) rails.set(1, { start: rowOf.get(C.devTip), key: 'dev' });
    const wipBy = new Map(wips.map((x) => [x.id, x]));
    const keyOf = (id) => (id >= M.N ? 'wip' : C.key[id]);
    // 父提交被隐藏了：沿第一父往上找到第一个显示的，线才接得上
    const up = (p) => {
      while (p !== undefined && !rowOf.has(p)) p = M.P[p]?.[0];
      return p;
    };
    const parentsOf = (id) => (id >= M.N ? [wipBy.get(id).c] : [...new Set(M.P[id].map(up).filter((p) => p !== undefined))]);
    const Lr = layout(order, parentsOf, { pin, rails, keyOf });
    const bf = S.branch ? branchFocus(S.branch) : null;
    const focusKey = S.branch ? keyOfBranch(S.branch) : null;
    const focus = bf ? (id) => id < M.N && bf.ids.has(id) : S.who != null ? (id) => id < M.N && M.a[id] === S.who : null;
    V = { order, rows: Lr.rows, width: Math.min(Math.max(Lr.width, 2), MAX_LANES), wips: wipBy, rowOf, focus, focusKey, litKeys: bf?.keys ?? null };
    V.gw = PAD * 2 + (V.width - 1) * LW;
    gcol.style.setProperty('--gw', V.gw + 'px');
    placeMsgHandle();
    body.style.height = order.length * RH + 'px';
    computeMatches();
    painted = { first: -1, last: -1 };
    drawHead();
  }

  function computeMatches() {
    const q = S.q.trim().toLowerCase();
    V.match = null;
    V.matchSet = null;
    if (q) {
      const pids = new Set(M.people.filter((p) => p.name.toLowerCase().includes(q) || p.names.some((n) => n.toLowerCase().includes(q))).map((p) => p.id));
      V.match = [];
      V.order.forEach((id, r) => {
        if (id < M.N && (M.s[id].toLowerCase().includes(q) || M.h[id].startsWith(q) || pids.has(M.a[id]))) V.match.push(r);
      });
      V.matchSet = new Set(V.match);
    }
    const qc = bar.querySelector('[data-qcount]');
    if (qc) qc.textContent = V.match ? `${V.match.length ? (V.match.indexOf(selRow) + 1 || '–') + '/' : ''}${V.match.length}` : '';
  }

  /* ================= 主线视图：dev、main 两条并行线 ================= */
  // 行 = 两条主线第一父链上的提交（合进来的功能分支只剩那一个合并提交）+ 还没合进去的分支的提交 + 本机没提交的改动。
  // 每条主线在每一行：实线 = 它已经有这一行的改动（合并提交看被合进来的那一边），虚线 = 还没有。
  const TX = { rail0: 18, gap: 30, side: 22, lane: 14, maxSide: 6 };
  const mcCache = new Map();

  /** 合并提交带进来多少个提交（不算合并提交）、是谁写的。 */
  function mergeCount(id) {
    let v = mcCache.get(id);
    if (v) return v;
    const A = M.anc(id);
    const B = M.anc(M.P[id][0]);
    let n = 0;
    const tally = new Map();
    for (let w = 0; w < A.length; w++) {
      let x = A[w] & ~B[w];
      while (x) {
        const b = 31 - Math.clz32(x);
        x &= ~(1 << b);
        const c = w * 32 + b;
        if (M.P[c].length > 1) continue;
        n++;
        tally.set(M.a[c], (tally.get(M.a[c]) ?? 0) + 1);
      }
    }
    v = { n, people: [...tally].sort((a, b) => b[1] - a[1]).map(([a]) => a) };
    mcCache.set(id, v);
    return v;
  }

  function computeTrunk() {
    const rails = [];
    if (C.mainTip >= 0) rails.push({ name: C.mainName, key: 'main', tip: C.mainTip });
    if (C.devTip >= 0) rails.push({ name: C.devName, key: 'dev', tip: C.devTip });
    rails.forEach((R, i) => {
      R.x = TX.rail0 + i * TX.gap;
      R.on = new Uint8Array(M.N);
      R.chain = [];
      for (let c = R.tip; c !== undefined && c >= 0; c = M.P[c][0]) {
        R.on[c] = 1;
        R.chain.push(c);
      }
      R.A = M.anc(R.tip);
    });
    const onRail = (c) => rails.some((R) => R.on[c]);

    // 还没合进去的分支（顶部开关里没隐藏的）
    const sides = [...C.show, ...C.stale].filter((b) => (b.status === 'active' || b.status === 'stale') && drawn(b.name));
    const sideOf = new Map();
    for (const b of sides) for (const c of C.owned.get(b.name) ?? []) sideOf.set(c, b.name);
    const inRows = (c) => onRail(c) || sideOf.has(c);
    const upTo = (c) => {
      while (c !== undefined && c >= 0 && !inRows(c)) c = M.P[c][0];
      return c ?? -1;
    };

    // 本机没提交的改动：挂在它基于的那一行上面
    const wips = wipNodes().map((x) => ({ ...x, base: upTo(x.c) }));
    const wipAt = new Map();
    for (const x of wips) {
      if (x.base < 0) continue;
      if (!wipAt.has(x.base)) wipAt.set(x.base, []);
      wipAt.get(x.base).push(x.id);
    }
    const order = [];
    for (let i = 0; i < M.N; i++) {
      if (!inRows(i)) continue;
      const w = wipAt.get(i);
      if (w) order.push(...w);
      order.push(i);
    }
    const rowOf = new Map(order.map((id, r) => [id, r]));
    const rows = order.map((id) => ({ id }));

    // 每条主线逐行：有没有这一行的改动。分支和本机改动那几行不算数，沿用下面一行的状态
    for (const R of rails) {
      R.start = 0; // 两条线都从最上面画起：比另一条新的那几行，这条线是虚的
      R.has = new Uint8Array(order.length);
      let below = 1;
      for (let r = order.length - 1; r >= 0; r--) {
        const id = order[r];
        if (id < M.N && !sideOf.has(id)) below = has(R.A, M.P[id].length > 1 ? M.P[id][1] : id) ? 1 : 0;
        R.has[r] = below;
      }
    }

    // 节点画在哪（主线上的提交画在它所在的线上；两条线共有的历史两条线上都画）
    const nodes = new Map();
    for (const id of order) if (id < M.N && !sideOf.has(id)) nodes.set(id, rails.filter((R) => R.on[id]).map((R) => ({ x: R.x, key: R.key })));

    // 合并：两条主线之间的是发布 / 回合，画连线；其余是合进来的功能分支，收成一行
    const conns = [];
    for (let r = 0; r < order.length; r++) {
      const id = order[r];
      if (id >= M.N || sideOf.has(id) || M.P[id].length < 2) continue;
      const p1 = M.P[id][1];
      const pr = M.prByMerge?.get(M.h[id]);
      const mm = mergeNames(M.s[id]);
      // 两条线共有的提交：按说明里「合进哪」算它属于哪条线
      const X = rails.find((R) => R.on[id] && R.name === (pr?.base ?? mm.into)) ?? rails.find((R) => R.on[id]);
      const Y = rails.find((R) => R !== X && R.on[p1] && !R.on[id]);
      const src = pr?.head ?? mm.from;
      const other = rails.find((R) => R !== X && R.name === src);
      if (Y || (other && mm.into !== src && (!mm.into || mm.into === X.name))) {
        // 两条主线之间：发布（dev → main）/ 回合（main → dev）
        const from = Y ?? other;
        rows[r] = { id, kind: X.key === 'main' ? 'release' : 'back', from: from.name, to: X.name, toKey: X.key };
        if (Y && rowOf.has(p1)) conns.push({ r1: rowOf.get(p1), r2: r, x1: Y.x, x2: X.x, key: X.key });
      } else if (src && rails.some((R) => R.name === src)) {
        // 把主线合进别处（pull 产生的、或分支同步主线后快进上来的）：内容本来就在主线上
        rows[r] = { id, kind: 'sync', from: src, to: mm.into ?? X.name, toKey: X.key };
      } else {
        rows[r] = { id, kind: 'feat', to: X.name, branch: src, title: pr?.title ?? mm.rest };
      }
    }

    // 右边的分支：各占一道，从最新的提交竖着画到最早的，再弯回它分出来的地方
    const groups = [];
    for (const b of sides) {
      const rs = (C.owned.get(b.name) ?? []).map((c) => rowOf.get(c)).filter((r) => r !== undefined);
      if (!rs.length) continue;
      const top = Math.min(...rs);
      const bot = Math.max(...rs);
      const t = upTo(M.P[order[bot]]?.[0]);
      groups.push({ key: 'b:' + b.name, ids: rs.map((r) => order[r]), top, bot, target: t >= 0 ? t : null });
    }
    for (const x of wips) if (x.base >= 0) groups.push({ key: 'wip', ids: [x.id], top: rowOf.get(x.id), bot: rowOf.get(x.id), target: x.base, dash: true });
    groups.sort((a, b) => a.top - b.top);
    const ends = [];
    const sideX = (k) => TX.rail0 + (rails.length - 1) * TX.gap + TX.side + Math.min(k, TX.maxSide - 1) * TX.lane;
    for (const g of groups) {
      const until = g.target != null ? rowOf.get(g.target) : g.bot;
      let k = 0;
      while (ends[k] !== undefined && ends[k] >= g.top) k++;
      ends[k] = until;
      g.x = sideX(k);
      for (const id of g.ids) nodes.set(id, [{ x: g.x, key: g.key }]);
    }
    const lines = [];
    for (const g of groups) {
      if (g.bot > g.top) lines.push({ r1: g.top, r2: g.bot, x1: g.x, x2: g.x, key: g.key, dash: g.dash });
      if (g.target != null) lines.push({ r1: g.bot, r2: rowOf.get(g.target), x1: g.x, x2: nodes.get(g.target)?.[0]?.x ?? TX.rail0, key: g.key, dash: g.dash, fork: true });
    }

    // 环境标签：挂在它运行的提交上；那个提交被收进了合并里，就挂在主线上第一个包含它的那一行
    const envAt = new Map();
    for (const e of C.envs) {
      if (e.c < 0) continue;
      let at = rowOf.has(e.c) ? e.c : -1;
      const R = rails.find((x) => x.name === e.branch) ?? rails.find((x) => has(x.A, e.c));
      if (at < 0 && R && has(R.A, e.c)) {
        let lo = 0;
        let hi = R.chain.length - 1; // chain[0] 是最新的：包含 e.c 的是前面一段，找最后一个
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (M.isAncestor(e.c, R.chain[mid])) lo = mid;
          else hi = mid - 1;
        }
        at = R.chain[lo];
      }
      if (at < 0) continue;
      if (!envAt.has(at)) envAt.set(at, []);
      envAt.get(at).push(e);
    }

    let focusKey = S.branch ? keyOfBranch(S.branch) : null;
    const focusRail = rails.find((R) => R.key === focusKey);
    // 还没合进去的分支画在右边（sideOf）；已经合进主线的在这里没有自己的线，按 branchFocus 点亮它那段提交，连线不按 key 压暗
    const onSide = !focusRail && S.branch && [...sideOf.values()].includes(S.branch);
    const bf = S.branch && !focusRail && !onSide ? branchFocus(S.branch) : null;
    if (bf) focusKey = null;
    const focus = focusRail ? (id) => id < M.N && !!focusRail.on[id] : onSide ? (id) => id < M.N && 'b:' + sideOf.get(id) === focusKey : bf ? (id) => id < M.N && bf.ids.has(id) : S.who != null ? (id) => id < M.N && M.a[id] === S.who : null;
    const used = Math.min(ends.length, TX.maxSide);
    const gw = (used ? sideX(used - 1) : TX.rail0 + (rails.length - 1) * TX.gap) + 16;
    V = { mode: 'trunk', order, rowOf, rows, rails, nodes, conns, lines, envAt, sideOf, wips: new Map(wips.map((x) => [x.id, x])), focus, focusKey, gw };
    gcol.style.setProperty('--gw', gw + 'px');
    placeMsgHandle();
    body.style.height = order.length * RH + 'px';
    computeMatches();
    painted = { first: -1, last: -1 };
    drawHead();
  }

  /** 图上方：两条线的名字对准各自的线，外加一句读法 */
  function drawHead() {
    if (V.mode !== 'trunk') {
      // 完整视图的图例：每种线是什么意思
      head.hidden = false;
      const sw = (d) => `<svg width="18" height="12" aria-hidden="true">${d}</svg>`;
      head.innerHTML = `<span class="glegend">
        <span data-tip="${esc(`${C.mainName ?? 'main'}（上线分支）`)}">${sw(`<path d="M2 6H16" stroke="${colorFor('main')}" stroke-width="4"/>`)}${esc(C.mainName ?? 'main')}</span>
        ${C.devName ? `<span data-tip="${esc(`${C.devName}（集成分支）`)}">${sw(`<path d="M2 6H16" stroke="${colorFor('dev')}" stroke-width="4"/>`)}${esc(C.devName)}</span>` : ''}
        <span data-tip="还没合进主线的分支：左栏加到图上的才画">${sw('<path d="M2 6H16" stroke="var(--s4)" stroke-width="2"/><circle cx="9" cy="6" r="3.5" fill="var(--s4)"/>')}进行中</span>
        <span data-tip="已经合进主线的分支：保留它自己的颜色，最后一个提交旁标着分支名（认不出名字的写「某某的提交」）">${sw('<path d="M2 6H16" stroke="var(--s5)" stroke-width="2"/><circle cx="9" cy="6" r="3" fill="var(--s5)"/>')}已合并</span>
        <span data-tip="合并提交：一条分支在这里合进来">${sw(`<circle cx="9" cy="6" r="4" fill="var(--surface)" stroke="var(--muted)" stroke-width="2"/>`)}合并点</span>
        <span data-tip="本机还没提交的改动">${sw('<circle cx="9" cy="6" r="4" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="2 2"/>')}本机改动</span>
      </span>`;
      return;
    }
    head.hidden = false;
    const T = O.trunk;
    head.innerHTML = `${V.rails.map((R) => `<span class="hrail" style="left:${R.x}px;--c:${colorFor(R.key)}" data-branch-focus="${esc(R.name)}" data-tip="${esc(`${R.name}：点一下看它的详情`)}">${esc(R.name)}</span>`).join('')}
      <span class="hlegend" style="left:${V.gw}px" data-tip="${esc('读法：\n每条竖线是一条分支（左 main、右 dev）\n实线 = 这条分支已经有这一行的改动，虚线 = 还没有\n两线之间的连线 = 发布（dev 合进 main）或回合（main 合回 dev）\n「合并 xxx · N」= 一条功能分支合了进来，点开看它带进来的提交\n右边彩色的线 = 还没合进去的分支')}">
        ${T && V.rails.length > 1 ? `<span class="${T.ahead.count ? 'on' : ''}" data-branch-focus="${esc(T.dev)}" data-trunk-open="ahead">${icon.arrowRight(10)}${T.ahead.count} 待上线</span><span class="${T.behind.count ? 'on warn' : ''}" data-branch-focus="${esc(T.main)}" data-trunk-open="behind">${icon.arrowLeft(10)}${T.behind.count} 没回合</span>` : ''}${icon.info(12)}
      </span>`;
  }

  function svgTrunk(first, last) {
    const y = (r) => (r - first) * RH + RH / 2;
    const vis = (a, b) => Math.max(a, b) >= first && Math.min(a, b) < last;
    const dimOf = (key) => (V.focusKey && V.focusKey !== key ? ' opacity=".25"' : '');
    let out = '';
    // 连到主线的分支线、本机改动的虚线（最底下）
    for (const L of V.lines) {
      if (!vis(L.r1, L.r2)) continue;
      const y1 = y(L.r1);
      const y2 = y(L.r2);
      // 分出来的那一段：竖着下来，最后一行里弯进它分出来的线
      const ym = Math.max(y1, y2 - RH);
      const d = L.fork ? `M${L.x1} ${y1}V${ym}C${L.x1} ${(ym + y2) / 2} ${L.x2} ${(ym + y2) / 2} ${L.x2} ${y2}` : `M${L.x1} ${y1}V${y2}`;
      out += `<path d="${d}" fill="none" stroke="${colorFor(L.key)}" stroke-width="2" stroke-linecap="round"${L.dash ? ' stroke-dasharray="3 4"' : ''}${dimOf(L.key)}/>`;
    }
    // 两条主线：实线 = 有，虚线 = 还没有
    for (const R of V.rails) {
      let solid = '';
      let dashed = '';
      for (let r = Math.max(first, R.start); r < last; r++) {
        const seg = `M${R.x} ${r === R.start ? y(r) : y(r) - RH / 2}V${y(r) + RH / 2}`;
        if (R.has[r]) solid += seg;
        else dashed += seg;
      }
      if (dashed) out += `<path d="${dashed}" fill="none" stroke="var(--muted)" stroke-width="2" stroke-dasharray="2 5" stroke-linecap="round" opacity=".5"/>`;
      if (solid) out += `<path d="${solid}" fill="none" stroke="${colorFor(R.key)}" stroke-width="4"${dimOf(R.key)}/>`;
    }
    // 发布 / 回合：两条线之间的连线
    for (const c of V.conns) {
      if (!vis(c.r1, c.r2)) continue;
      out += `<path d="${segPath(c.x1, y(c.r1), c.x2, y(c.r2))}" fill="none" stroke="${colorFor(c.key)}" stroke-width="2.5" stroke-linecap="round"${dimOf(c.key)}/>`;
    }
    const nodes = [];
    for (let r = first; r < last; r++) {
      const id = V.order[r];
      const cy = y(r);
      if (id >= M.N) {
        const x = V.nodes.get(id)?.[0]?.x ?? TX.rail0;
        nodes.push(`<circle cx="${x}" cy="${cy}" r="5" fill="var(--surface)" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="2 2"/>`);
        continue;
      }
      const dim = V.focus && !V.focus(id) ? ' opacity=".25"' : '';
      const merge = M.P[id].length > 1;
      for (const n of V.nodes.get(id) ?? []) {
        const color = colorFor(n.key);
        const rr = TRUNKS.has(n.key) ? 5.5 : 4.5;
        if (r === selRow) nodes.push(`<circle cx="${n.x}" cy="${cy}" r="${rr + 6}" fill="${color}" opacity=".18"/>`);
        if (merge) nodes.push(`<circle cx="${n.x}" cy="${cy}" r="${rr - 0.5}" fill="var(--surface)" stroke="${color}" stroke-width="2.5"${dim}/>`);
        else nodes.push(`<circle cx="${n.x}" cy="${cy}" r="${r === selRow ? rr + 1 : rr}" fill="${color}" stroke="var(--surface)" stroke-width="2"${dim}/>`);
      }
    }
    return `<svg class="gsvg" width="${V.gw}" height="${(last - first) * RH}" style="top:${first * RH}px">${out}${nodes.join('')}</svg>`;
  }

  const lx = (l) => PAD + l * LW;
  const isRail = (s) => s[0] === s[2] && s[0] <= 1 && TRUNKS.has(s[4]);

  function labels(id) {
    const out = [];
    for (const e of (V.envAt ?? C.envAt).get(id) ?? []) out.push(envPill(e, railOf(e)));
    for (const r of M.refsAt.get(id) ?? []) {
      if (r.kind !== 'R') continue;
      const n = r.short ?? r.name;
      const k = n === C.mainName ? 'main' : n === C.devName ? 'dev' : C.colorOf.has('b:' + n) ? 'b:' + n : null;
      if (!k) continue;
      const here = M.worktrees.filter((w) => w.branch === n);
      out.push(`<span class="bn${TRUNKS.has(k) ? ' trunk' : ''}" style="--c:${colorFor(k)}" data-tip-c="${colorFor(k)}" data-tip="${esc(`${n}\n云端分支，指向这个提交${here.length ? '\n本机检出：' + here.map((w) => w.path).join('，') : ''}`)}">${icon.cloud(11)}<span data-mid="${esc(n)}">${esc(n)}</span>${here.length ? icon.desktop(10) : ''}</span>`);
    }
    // 完整视图：已经合并完的分支，在它最后一个提交上标出名字（分支本身可能已经删了）
    const mt = V.mode !== 'trunk' ? C.mergedTip.get(id) : null;
    if (mt && !out.length) {
      const who = mt.direct ? `${mt.name.slice(1)} · 直接提交在 ${mt.direct}` : mt.name.startsWith('@') ? `${mt.name.slice(1)} 的提交` : mt.name;
      const what = mt.direct
        ? `${mt.name.slice(1)} 直接提交在 ${mt.direct} 上的改动：本地 ${mt.direct} 和云端同时有新提交，git pull 时合成了一个合并，这条线是其中一边\n颜色按作者`
        : mt.name.startsWith('@')
          ? `${mt.name.slice(1)} 的提交（认不出分支名，按作者上色）\n已经合进 ${mt.into}`
          : `分支 ${mt.name}\n已经合进 ${mt.into}`;
      out.push(`<span class="bn done" style="--c:${colorFor('h:' + mt.name)}" data-tip-c="${colorFor('h:' + mt.name)}" data-tip="${esc(`${what}\n这条线往下是它的提交，往上连到合并的地方`)}">${icon.merge(10)}${mt.direct || mt.name.startsWith('@') ? esc(who) : `<span data-mid="${esc(who)}">${esc(who)}</span>`}</span>`);
    }
    return out.join('');
  }

  /** 图上的节点（悬停线和点那一格）：这个提交属于哪条分支（用那条分支的颜色）、谁、什么时候、走到哪了 */
  function nodeTip(id) {
    const k = C.key[id];
    const branch = k === 'main' ? C.mainName : k === 'dev' ? C.devName : k.startsWith('b:') ? k.slice(2) : k.startsWith('h:@') ? `${k.slice(3)} 的提交` : k.startsWith('h:') ? k.slice(2) : null;
    const state = k === 'main' || k === 'dev' ? '直接在主线上' : k.startsWith('b:') ? '进行中的分支' : '已经合进主线';
    const p = M.person(M.a[id]);
    const st = stops();
    return tipCard({
      c: colorFor(k),
      title: branch ?? '已合并的历史',
      sub: `${avatar(p, 16)}<span>${esc(p?.name ?? '?')}</span><span>·</span><span>${esc(ago(M.t[id]))}</span><span>·</span><span class="mono">${M.short(id)}</span>`,
      lines: [M.s[id].length > 80 ? M.s[id].slice(0, 79) + '…' : M.s[id], M.P[id].length > 1 ? `合并提交 · ${state}` : state],
      dots: st.map((s) => ({ on: M.isAncestor(id, s.tip), c: colorFor(s.k), env: s.env, label: `${s.env ? '环境 ' : ''}${s.name}${M.isAncestor(id, s.tip) ? '' : '（还没有）'}` })),
      hint: '点击看改了哪些文件',
    });
  }

  function rowHtml(r) {
    const id = V.order[r];
    const style = `top:${r * RH}px;height:${RH}px`;
    if (id >= M.N) {
      const x = V.wips.get(id);
      return `<div class="gr wip${selRow === r ? ' sel' : ''}" data-r="${r}" style="${style}"><div class="gg"></div><div class="gm"><span class="wipt" data-tip="${esc(x.w.path)}">${icon.desktop(11)}${esc(x.w.path.split('\\').pop())}</span><span class="gs">${icon.pencil(11)} ${x.w.total}</span></div><div class="ga"></div><div class="gt"></div></div>`;
    }
    const p = M.person(M.a[id]);
    const dim = V.focus && !V.focus(id);
    const tk = V.mode === 'trunk' ? V.rows[r] : null;
    const cls = `gr${selRow === r ? ' sel' : ''}${dim ? ' dim' : ''}${V.matchSet?.has(r) ? ' match' : ''}${M.P[id].length > 1 && !tk?.kind ? ' merge' : ''}${TRUNKS.has(C.key[id]) ? ' trunk' : ''}`;
    let text = `<span class="gs">${esc(M.s[id])}</span>`;
    if (tk?.kind) {
      // 主线视图里的合并：发布 / 回合 / 合进来的功能分支，都写成一句人话，数出带进来多少提交
      const mc = mergeCount(id);
      const n = `<span class="mcnt" data-tip="${esc(`带进来 ${mc.n} 个提交（不算合并提交），点这一行看明细`)}">${mc.n}${mc.people.slice(0, 3).map((a) => avatar(M.person(a), 14)).join('')}</span>`;
      if (tk.kind === 'sync') {
        text = `<span class="mk sync" data-tip="${esc(`同步：把 ${tk.from} 合进 ${tk.to}（${tk.from} 本来就有这些改动，只是对齐）\n${M.s[id]}`)}">同步</span><span class="gs sub">${esc(tk.from)} ${icon.arrowRight(10)} ${esc(tk.to)}</span>`;
      } else if (tk.kind === 'release' || tk.kind === 'back') {
        text = `<span class="mk ${tk.kind}" style="--c:${colorFor(tk.toKey)}" data-tip="${esc(tk.kind === 'release' ? `发布：把 ${tk.from} 合进 ${tk.to}` : `回合：把 ${tk.from} 合回 ${tk.to}`)}">${tk.kind === 'release' ? '发布' : '回合'}</span><span class="gs">${esc(tk.from)} ${icon.arrowRight(10)} ${esc(tk.to)}</span>${n}`;
      } else {
        const name = tk.branch;
        text = `<span class="mk feat" style="--c:${name ? branchColor(name) : 'var(--muted)'}" data-tip-c="${name ? branchColor(name) : 'var(--muted)'}" data-tip="${esc(`合并：把 ${name ?? '一条分支'} 合进 ${tk.to}\n${M.s[id]}`)}">${icon.merge(10)}<span data-mid="${esc(name ?? '合并')}">${esc(name ?? '合并')}</span></span>${n}<span class="gs sub">${esc(tk.title ?? '')}</span>`;
      }
    }
    return `<div class="${cls}" data-r="${r}" style="${style}"><div class="gg" data-tip-html data-tip="${esc(nodeTip(id))}"></div><div class="gm">${labels(id)}${text}</div><div class="ga" data-tip="${esc(p?.name ?? '')}">${avatar(p, 18)}</div><div class="gt" data-tip="${fullStamp(M.t[id])}">${when(M.t[id])}</div></div>`;
  }

  function svgHtml(first, last) {
    const paths = new Map();
    const add = (k, w, d) => {
      const g = k + '|' + w;
      paths.set(g, (paths.get(g) ?? '') + d);
    };
    const nodes = [];
    for (let r = first; r < last; r++) {
      const row = V.rows[r];
      const y = (r - first) * RH;
      for (const s of row.segs) {
        if (s[0] >= MAX_LANES && s[2] >= MAX_LANES) continue;
        add(s[4], isRail(s) ? 4 : 2, segPath(lx(Math.min(s[0], MAX_LANES - 1)), y + s[1] * RH, lx(Math.min(s[2], MAX_LANES - 1)), y + s[3] * RH));
      }
      const id = V.order[r];
      const cx = lx(Math.min(row.lane, MAX_LANES - 1));
      const cy = y + RH / 2;
      if (id >= M.N) {
        nodes.push(`<circle cx="${cx}" cy="${cy}" r="5" fill="var(--surface)" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="2 2"/>`);
        continue;
      }
      const k = C.key[id];
      // 已合并的分支和进行中的一样用它自己的颜色画实（看得清每个人的分支是怎么合进来的），只是节点小一点
      const done = k === 'hist' || k.startsWith('h:');
      const op = V.focus && !V.focus(id) ? 0.22 : 1;
      const o = op < 1 ? ` opacity="${op}"` : '';
      const rr = TRUNKS.has(k) ? 5.5 : done ? 3.8 : 4.5;
      const color = colorFor(k);
      // 选中：用它自己的颜色画一圈柔和的光晕（不画黑圈）
      if (r === selRow) nodes.push(`<circle cx="${cx}" cy="${cy}" r="${rr + 6}" fill="${color}" opacity=".18"/>`);
      if (M.P[id].length > 1) nodes.push(`<circle cx="${cx}" cy="${cy}" r="${rr - 0.5}" fill="var(--surface)" stroke="${color}" stroke-width="2.5"${o}/>`);
      else nodes.push(`<circle cx="${cx}" cy="${cy}" r="${r === selRow ? rr + 1 : rr}" fill="${color}" stroke="var(--surface)" stroke-width="2"${o}/>`);
    }
    let out = '';
    // 细线在下、粗轨道在上；选中分支时别的线淡下去
    for (const [g, d] of [...paths].sort((a, b) => Number(a[0].split('|')[1]) - Number(b[0].split('|')[1]))) {
      const [k, w] = g.split('|');
      const op = V.litKeys && !V.litKeys.has(k) ? 0.22 : k === 'hist' ? 0.5 : 1;
      out += `<path d="${d}" fill="none" stroke="${colorFor(k)}" stroke-width="${w}" stroke-linecap="round"${k === 'wip' ? ' stroke-dasharray="3 4"' : ''}${op < 1 ? ` opacity="${op}"` : ''}/>`;
    }
    return `<svg class="gsvg" width="${V.gw}" height="${(last - first) * RH}" style="top:${first * RH}px">${out}${nodes.join('')}</svg>`;
  }

  function paint(force = false) {
    const top = list.scrollTop;
    const first = Math.max(0, Math.floor(top / RH) - OVERSCAN);
    const last = Math.min(V.order.length, Math.ceil((top + list.clientHeight) / RH) + OVERSCAN);
    if (!force && first === painted.first && last === painted.last) return;
    painted = { first, last };
    let html = V.mode === 'trunk' ? svgTrunk(first, last) : svgHtml(first, last);
    for (let r = first; r < last; r++) html += rowHtml(r);
    body.innerHTML = html;
  }
  let raf = 0;
  list.addEventListener('scroll', () => {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); });
  });
  const ro = new ResizeObserver(() => {
    paint(true);
    placeMsgHandle();
  });
  ro.observe(list);
  const barRo = new ResizeObserver(() => {
    fitChips();
    placeMsgHandle();
  });
  barRo.observe(bar);
  barRo.observe(head);

  function scrollToRow(r, center = false) {
    const y = r * RH;
    const h = list.clientHeight;
    if (center) list.scrollTop = Math.max(0, y - h / 2 + RH / 2);
    else if (y < list.scrollTop) list.scrollTop = y;
    else if (y + RH > list.scrollTop + h) list.scrollTop = y + RH - h;
  }

  /* ================= 右边：第二层分支、第三层提交 ================= */
  function closeDetail() {
    detailToken++;
    D.hidden = true;
    selRow = -1;
    S.sel = null;
    S.env = null;
    ctx.setParams({ c: null, env: null, t: S.branch ? S.tab : null });
    drawLeft();
    paint(true);
  }
  function dtop(back, envBack = false) {
    const ev = envBack && S.env ? C.envs.find((x) => x.id === S.env) : null;
    const b = back
      ? `<button class="back" data-back data-tip="回到分支">${icon.arrowLeft(13)}<i class="dot" style="background:${colorFor(keyOfBranch(back))}"></i>${esc(back)}</button>`
      : ev ? `<button class="back" data-back-env data-tip="回到环境">${icon.arrowLeft(13)}${icon.server(11)}${esc(ev.name)}</button>` : '';
    return `<div class="dtop">${b}<span class="grow"></span><button class="icon-btn" data-close data-tip="关闭 (Esc)">${icon.close(14)}</button></div>`;
  }

  function showBranch(name) {
    detailToken++;
    const k = keyOfBranch(name);
    const tip = M.branches.get(name)?.tip ?? -1;
    if (tip < 0) return closeDetail();
    const b = O.branches.find((x) => x.name === name);
    const owner = b ? O.persons[b.owner] : M.person(M.a[tip]);
    const T = O.trunk;
    const isTrunkPair = T && (name === T.dev || name === T.main);
    let commits;
    if (isTrunkPair) commits = [];
    else if (TRUNKS.has(k)) {
      commits = [];
      for (let c = tip; c !== undefined && c >= 0 && commits.length < 40; c = M.P[c][0]) commits.push(c);
    } else {
      commits = [...(C.owned.get(name) ?? [])].sort((x, y) => x - y).slice(0, 80);
      // 已经合进主线的：列出图上点亮的那段（从它合进来的 / 它自己那条线），并注明已合并
      if (!commits.length) commits = [...branchFocus(name).ids].sort((x, y) => x - y).slice(0, 80);
    }
    const allMerged = !TRUNKS.has(k) && !(C.owned.get(name) ?? []).length;
    D.hidden = false;
    D.innerHTML = `${dtop(null)}
      <div class="bhead" style="--c:${colorFor(k)}"><i class="${TRUNKS.has(k) ? 'rbar' : 'dot'}"></i><h3>${esc(name)}</h3>${(O.branchTags?.[name] ?? []).map((t) => `<span class="utag">${esc(t)}</span>`).join('')}${C.envs.filter((e) => e.branch === name).map((e) => envPill(e, TRUNKS.has(k) ? k : null)).join('')}
        ${M.raw.slug ? `<a class="icon-btn" href="https://github.com/${esc(M.raw.slug)}/tree/${encodeURIComponent(name)}" target="_blank" rel="noreferrer" data-tip="在 GitHub 打开">${icon.ext(12)}</a>` : ''}</div>
      <div class="dmeta">${avatar(owner, 20)}<span>${esc(owner?.name ?? '')}</span><span class="muted" data-tip="${fullStamp(M.ct[tip])}">${ago(M.ct[tip])}</span>${b ? `<span class="muted" data-tip="${esc(`自己的提交 ${b.own} 个；${C.devName ?? C.mainName ?? '主线'} 比它多 ${b.behind ?? 0} 个`)}">${icon.arrowUp(10)}${b.own} ${icon.arrowDown(10)}${b.behind ?? 0}</span>` : ''}</div>
      ${stepsHtml(tip)}
      ${b?.pr ? prChip(b.pr, { full: true }) : ''}
      ${isTrunkPair ? trunkTabs(name, tip) : `${allMerged ? `<div class="quiet mergedn">${icon.check(12)} 已经全部合进主线${commits.length ? '，下面是它的提交' : ''}</div>` : ''}<div class="clist">${commits.map(crow).join('')}</div>`}`;
  }
  const crow = (c) => `<button class="crow" data-open="${c}">${journey(c)}<span class="s">${esc(M.s[c])}</span>${avatar(M.person(M.a[c]), 16)}<span class="t">${when(M.t[c])}</span></button>`;

  /** dev / main 的详情：待上线（dev 有 main 没有）、没回合（main 有 dev 没有）、最近提交，三个标签页 */
  function trunkTabs(name, tip) {
    const T = O.trunk;
    const tabs = [
      { id: 'ahead', label: '待上线', n: T.ahead.count, icon: icon.arrowRight(11), tip: `${T.dev} 上有、${T.main} 上还没有的提交（不算合并提交）` },
      { id: 'behind', label: '没回合', n: T.behind.count, icon: icon.arrowLeft(11), tip: `${T.main} 上有、${T.dev} 上没有的提交：直接改在 ${T.main} 上的，要合回 ${T.dev}`, warn: T.behind.count > 0 },
      { id: 'log', label: '最近', n: null, icon: icon.commit(11), tip: `${name} 最近的提交（沿第一父提交）` },
    ];
    let cur = S.tab && tabs.some((t) => t.id === S.tab) ? S.tab : name === T.main && T.behind.count ? 'behind' : name === T.dev && T.ahead.count ? 'ahead' : 'log';
    S.tab = cur;
    let body;
    if (cur === 'log') {
      const list = [];
      for (let c = tip; c !== undefined && c >= 0 && list.length < 40; c = M.P[c][0]) list.push(c);
      body = `<div class="clist">${list.map(crow).join('')}</div>`;
    } else {
      const pk = T[cur];
      if (!pk.count) body = `<div class="quiet">${icon.check(12)} ${cur === 'ahead' ? `${T.dev} 的改动都已经进了 ${T.main}` : `${T.main} 上没有需要合回 ${T.dev} 的提交`}</div>`;
      else body = ticketsHtml(pk.tickets ?? []) + groupedCommits(pk.commits, pk.count);
    }
    return `<div class="ttabs">${tabs.map((t) => `<button class="${t.id === cur ? 'on' : ''}${t.warn ? ' warn' : ''}" data-ttab="${t.id}" data-tip="${esc(t.tip)}">${t.icon}${t.label}${t.n != null ? `<span class="n">${t.n}</span>` : ''}</button>`).join('')}</div>${body}`;
  }

  /** 一组提交（{sha,s,a,t,ticket}）按成员分组列出，点提交打开详情 */
  function groupedCommits(list, total = list.length) {
    const groups = new Map();
    for (const x of list) {
      if (!groups.has(x.a)) groups.set(x.a, []);
      groups.get(x.a).push(x);
    }
    return [...groups].sort((a, b) => b[1].length - a[1].length).map(([a, xs]) => {
      const p = O.persons[a];
      return `<div class="tgrp"><div class="tgh">${avatar(p, 18)}<span>${esc(p?.name ?? '?')}</span><span class="n">${xs.length}</span></div>
        <div class="clist">${xs.map((x) => {
          const c = M.byHash.get(x.sha);
          return c === undefined ? '' : `<button class="crow" data-open="${c}">${x.ticket ? `<span class="ttag">${esc(x.ticket)}</span>` : ''}<span class="s">${esc(x.s)}</span><span class="t" data-tip="${fullStamp(x.t)}">${when(x.t)}</span></button>`;
        }).join('')}</div></div>`;
    }).join('') + (total > list.length ? `<div class="quiet">还有 ${total - list.length} 个没列出</div>` : '');
  }
  const TICKET = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/;
  /** a 有、b 没有的提交（不算合并提交），新的在前 */
  function diffList(a, b) {
    const A = M.anc(a);
    const B = M.anc(b);
    const out = [];
    for (let c = 0; c < M.N; c++) if (has(A, c) && !has(B, c) && M.P[c].length < 2) out.push({ sha: M.h[c], s: M.s[c], a: M.a[c], t: M.t[c], ticket: TICKET.exec(M.s[c])?.[0] ?? null });
    return out;
  }
  const ticketsHtml = (tks) => (tks.length ? `<div class="tks">${tks.slice(0, 30).map((t) => `<span class="ttag">${esc(t)}</span>`).join('')}${tks.length > 30 ? `<span class="muted">+${tks.length - 30}</span>` : ''}</div>` : '');

  /** 环境详情：它跑的是什么、分支上还有什么没部署、下次发布到后一个环境会带上什么、历次上线记录 */
  function showEnv(id) {
    detailToken++;
    const e = C.envs.find((x) => x.id === id);
    if (!e) return closeDetail();
    S.env = id;
    const k = railOf(e) ?? 'hist';
    const bTip = e.branch ? M.branches.get(e.branch)?.tip ?? -1 : -1;
    const cmp = O.envCompare ?? [];
    const next = cmp.find((x) => x.from === id);
    const prev = cmp.find((x) => x.to === id);
    const deps = (O.deploys ?? []).filter((d) => d.env === id);
    const pend = !e.assumed && e.c >= 0 && bTip >= 0 ? diffList(bTip, e.c) : null;
    const tabs = [
      pend ? { id: 'pending', label: '待部署', n: pend.length, tip: `${e.branch} 上有、${e.name}还没部署的提交` } : null,
      next ? { id: 'next', label: `发往${next.toName}`, n: next.pending.count, tip: `${e.name}里有、${next.toName}还没有的提交：下次发布到${next.toName}会带上这些（发布前核对清单）` } : null,
      prev && prev.skipped.count ? { id: 'skip', label: `没经过${prev.fromName}`, n: prev.skipped.count, warn: true, tip: `${e.name}里有、${prev.fromName}没有的提交：没经过${prev.fromName}就上了${e.name}` } : null,
      { id: 'log', label: '上线记录', n: deps.length, tip: 'BranchMap 每次探测到这个环境换了版本就记一条' },
    ].filter(Boolean);
    const cur = tabs.some((t) => t.id === S.tab) ? S.tab : tabs[0].id;
    S.tab = cur;
    let bodyHtml = '';
    if (cur === 'pending') bodyHtml = pend.length ? groupedCommits(pend.slice(0, 200), pend.length) : `<div class="quiet">${icon.check(12)} ${esc(e.branch)} 上的改动都已经部署了</div>`;
    else if (cur === 'next') {
      const P = next.pending;
      bodyHtml = P.count
        ? `<div class="chk"><span>${P.count} 个提交${P.tickets.length ? ` · ${P.tickets.length} 个工单` : ''}</span><span class="grow"></span><button class="btn sm" data-copy-list data-tip="复制发布清单（工单 + 提交说明）">${icon.copy(12)} 清单</button></div>${ticketsHtml(P.tickets)}${groupedCommits(P.commits, P.count)}`
        : `<div class="quiet">${icon.check(12)} ${esc(next.toName)}已经包含${esc(e.name)}的全部改动</div>`;
    } else if (cur === 'skip') bodyHtml = groupedCommits(prev.skipped.commits, prev.skipped.count);
    else {
      bodyHtml = deps.length
        ? `<div class="dlog">${deps.map((d, i) => {
            const to = M.byHash.get(d.to);
            const from = d.from ? M.byHash.get(d.from) : undefined;
            const sha = (c, h) => (c !== undefined ? `<button class="sha" data-open="${c}">${M.short(c)}</button>` : `<span class="sha">${esc(h.slice(0, 7))}</span>`);
            const A = d.added;
            const sum = A ? `${A.count ? `${A.count} 个提交` : '没有新提交'}${A.tickets.length ? ` · ${A.tickets.length} 个工单` : ''}${d.removed ? ` · <span class="warn">回退 ${d.removed} 个</span>` : ''}` : '';
            return `<div class="dep${i === 0 ? ' now' : ''}" style="--c:${colorFor(k)}"><i class="node"></i>
              <div class="dl1"><b>${esc(d.version ?? (to !== undefined ? M.short(to) : d.to.slice(0, 7)))}</b><span class="muted" data-tip="${fullStamp(d.t)}（BranchMap 发现的时间）">${when(d.t)}</span><span class="grow"></span>${d.from ? `${sha(from, d.from)}${icon.arrowRight(10)}` : ''}${sha(to, d.to)}</div>
              ${!d.from ? '<div class="dl2 muted">开始记录</div>' : A ? `<details class="dl2"><summary>${sum}<span class="avs">${A.people.slice(0, 4).map((x) => avatar(O.persons[x.id], 16)).join('')}</span></summary>${ticketsHtml(A.tickets)}${groupedCommits(A.commits, A.count)}</details>` : '<div class="dl2 muted">提交不在云端副本里，算不出带上了什么</div>'}
            </div>`;
          }).join('')}</div>`
        : `<div class="quiet">还没有记录。BranchMap 运行时每次探测到${esc(e.name)}换了版本就会记一条。</div>`;
    }
    const led = e.state === 'down' ? '<span class="led critical" data-tip="连不上"></span>' : e.assumed ? '<span class="led warning" data-tip="读不出运行的提交"></span>' : '<span class="led good" data-tip="在线"></span>';
    D.hidden = false;
    D.innerHTML = `${dtop(null)}
      <div class="bhead" style="--c:${colorFor(k)}"><span class="eic">${icon.server(14)}</span><h3>${esc(e.name)}</h3>${led}<span class="grow"></span><button class="icon-btn" data-env-edit="${esc(e.id)}" data-tip="改名、探测地址、删除">${icon.pencil(12)}</button></div>
      <div class="dmeta">
        ${e.branch ? `<button class="bref" data-branch-go="${esc(e.branch)}" style="--c:${colorFor(k)}" data-tip="来源分支：点击打开"><i></i>${esc(e.branch)}</button>` : ''}
        ${e.assumed ? `<span class="muted">${esc(e.probe ? e.detail ?? '读不出运行的提交' : '没填探测地址')}</span>` : `${e.version ? `<b>${esc(e.version)}</b>` : ''}<button class="sha" data-open="${e.c}" data-tip="正在运行的提交">${M.short(e.c)}</button>`}
        ${e.checkedAt ? `<span class="muted" data-tip="${fullStamp(e.checkedAt / 1000)}">${ago(e.checkedAt / 1000)}检查</span>` : ''}
      </div>
      ${e.assumed ? `<button class="hintbtn" data-open-settings>${icon.gear(12)} ${e.probe ? '检查探测地址' : '填探测地址，读出线上实际跑的版本'}</button>` : ''}
      <div class="ttabs">${tabs.map((t) => `<button class="${t.id === cur ? 'on' : ''}${t.warn ? ' warn' : ''}" data-etab="${t.id}" data-tip="${esc(t.tip)}">${t.label}${t.n != null ? `<span class="n">${t.n}</span>` : ''}</button>`).join('')}</div>
      ${bodyHtml}`;
    D._copy = () => {
      const P = next.pending;
      const lines = [`${e.name} → ${next.toName} 待发布：${P.count} 个提交`];
      if (P.tickets.length) lines.push(`工单：${P.tickets.join('、')}`);
      lines.push('', ...P.commits.map((x) => `- ${x.s}（${O.persons[x.a]?.name ?? '?'}）`));
      if (P.count > P.commits.length) lines.push(`…还有 ${P.count - P.commits.length} 个`);
      return lines.join('\n');
    };
  }
  function openEnv(id, tab = null) {
    S.env = id;
    S.branch = null;
    S.tab = tab;
    ctx.setParams({ env: id, b: null, c: null, t: tab, who: null });
    drawLeft();
    showEnv(id);
    const e = C.envs.find((x) => x.id === id);
    const r = e && e.c >= 0 ? V.rowOf.get(e.c) : undefined;
    if (r !== undefined) {
      selRow = r;
      scrollToRow(r, true);
    }
    paint(true);
  }
  function closeEnv() {
    S.env = null;
    ctx.setParams({ env: null, t: null });
  }

  /** 合并提交：它带进来的提交，按成员分组（主线视图里被收起来的就在这里展开） */
  function mergedIn(c) {
    const list = diffList(c, M.P[c][0]);
    if (!list.length) return '';
    return `<div class="dsec"><div class="dsh">${icon.merge(12)}带进来 ${list.length} 个提交</div>${groupedCommits(list.slice(0, 200), list.length)}</div>`;
  }

  function showCommit(c, back = null) {
    const my = ++detailToken;
    const p = M.person(M.a[c]);
    const pr = M.prByMerge?.get(M.h[c]);
    D.hidden = false;
    D.innerHTML = `${dtop(back, true)}
      <h3 class="dsub">${esc(M.s[c])}</h3>
      <pre class="dbody" data-body hidden></pre>
      <div class="dmeta">${avatar(p, 20)}<span>${esc(p?.name ?? '')}</span><span class="muted" data-tip="${fullStamp(M.t[c])}">${ago(M.t[c])}</span><button class="sha" data-copy="${M.h[c]}" data-tip="复制完整哈希">${M.short(c)}</button>${M.raw.slug ? `<a class="icon-btn" href="https://github.com/${esc(M.raw.slug)}/commit/${M.h[c]}" target="_blank" rel="noreferrer" data-tip="在 GitHub 打开">${icon.ext(12)}</a>` : ''}</div>
      ${stepsHtml(c)}
      ${pr ? prChip(pr, { full: true }) : ''}
      ${M.P[c].length > 1 ? mergedIn(c) : ''}
      <div class="dfiles" data-files><div class="quiet"><span class="spin" style="display:inline-grid">${icon.sync(12)}</span></div></div>`;
    store.commit(M.h[c]).then((d) => {
      if (my !== detailToken) return;
      const text = d.message.split('\n').slice(1).join('\n').trim();
      if (text) {
        const b = D.querySelector('[data-body]');
        b.textContent = text;
        b.hidden = false;
      }
      const add = d.files.reduce((s, f) => s + f.add, 0);
      const del = d.files.reduce((s, f) => s + f.del, 0);
      const box = D.querySelector('[data-files]');
      box.innerHTML = `<div class="fh"><span data-tip="改了几个文件">${icon.file(12)} ${d.files.length}</span>${lineStat(add, del)}</div>` + d.files.map((f, i) => `<button class="f" data-f="${i}" title="${esc(f.p)}"><span class="st ${f.st}">${f.st}</span>${fileName(f.p)}${f.bin ? '' : lineStat(f.add, f.del)}</button>`).join('');
      box.onclick = (e) => {
        const bt = e.target.closest('[data-f]');
        if (bt) openChanges({ title: M.s[c], sub: `${M.short(c)} · ${esc(p?.name ?? '')}`, files: d.files, select: d.files[Number(bt.dataset.f)].p, ...commitChangesLoader(store, d.base, d.h) });
      };
    }).catch((e) => {
      if (my === detailToken) D.querySelector('[data-files]').innerHTML = `<div class="quiet">${esc(e.message)}</div>`;
    });
  }

  function showWip(w) {
    detailToken++;
    const files = w.files ?? [];
    D.hidden = false;
    D.innerHTML = `${dtop(null)}
      <h3 class="dsub">${icon.desktop(14)} ${esc(w.path.split('\\').pop())}${w.branch ? ` · ${esc(w.branch)}` : ''}</h3>
      <div class="dmeta muted" style="word-break:break-all">${esc(w.path)}</div>
      <div class="dfiles"><div class="fh"><span data-tip="没提交的文件">${icon.pencil(12)} ${w.total}</span></div>${files.map((f, i) => `<button class="f" data-wf="${i}"><span class="st ${f.st}">${f.st}</span>${fileName(f.p)}${lineStat(f.add, f.del)}</button>`).join('')}</div>`;
    D.querySelector('.dfiles').onclick = (e) => {
      const bt = e.target.closest('[data-wf]');
      if (!bt) return;
      openChanges({
        title: `没提交的改动 · ${w.path.split('\\').pop()}`,
        sub: esc(w.path),
        files,
        select: files[Number(bt.dataset.wf)].p,
        load: (f, opts) => store.wtdiff({ wt: w.id, path: f.p, old: f.old, untracked: f.st === 'U', ctx: opts.ctx, ws: opts.ws }),
      });
    };
  }

  function select(r, { scroll = true, center = false } = {}) {
    if (r < 0 || r >= V.order.length) return;
    selRow = r;
    if (scroll) scrollToRow(r, center);
    paint(true);
    const id = V.order[r];
    if (id >= M.N) {
      showWip(V.wips.get(id).w);
      ctx.setParams({ c: null });
      return;
    }
    S.sel = M.h[id];
    ctx.setParams({ c: S.sel });
    showCommit(id, S.branch);
  }

  /* ================= 环境标签：加 / 改 / 删 ================= */
  function labelEditor(anchor, { branch, env }) {
    closePop();
    document.querySelector('.lpop')?.remove();
    const pop = document.createElement('div');
    pop.className = 'pop lpop';
    pop.innerHTML = `
      <input class="lin" data-name placeholder="生产" value="${esc(env?.name ?? '')}" maxlength="20" data-tip="标签名">
      <input class="lin" data-probe placeholder="https://…/health" value="${esc(env?.probe ?? '')}" data-tip="健康接口地址（可选）：填了就读出线上实际跑的提交，不填就挂在分支最新提交上">
      <div class="lrow">${env ? `<button class="icon-btn" data-del data-tip="删除这个标签">${icon.close(13)}</button>` : ''}<span class="grow"></span><button class="btn primary sm" data-save data-tip="保存">${icon.check(12)}</button></div>`;
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.min(r.left, innerWidth - 300) + 'px';
    pop.style.top = r.bottom + 6 + 'px';
    const name = pop.querySelector('[data-name]');
    const probe = pop.querySelector('[data-probe]');
    setTimeout(() => name.focus(), 0);
    const current = () => C.envs.map((e) => ({ id: e.id, name: e.name, branch: e.branch, probe: e.probe }));
    const close = () => {
      pop.remove();
      document.removeEventListener('mousedown', off);
    };
    const save = async (list) => {
      pop.querySelectorAll('button').forEach((b) => (b.disabled = true));
      try {
        const res = await fetch(`/api/p/${encodeURIComponent(ctx.id)}/labels`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ environments: list }) });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error);
        close();
      } catch (e) {
        toast(e.message);
        pop.querySelectorAll('button').forEach((b) => (b.disabled = false));
      }
    };
    pop.addEventListener('click', (e) => {
      if (e.target.closest('[data-del]')) save(current().filter((x) => x.id !== env.id));
      else if (e.target.closest('[data-save]')) {
        const n = name.value.trim() || name.placeholder;
        const list = current();
        if (env) Object.assign(list.find((x) => x.id === env.id), { name: n, probe: probe.value.trim() || null });
        else list.push({ name: n, branch, probe: probe.value.trim() || null });
        save(list);
      }
    });
    pop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') pop.querySelector('[data-save]').click();
      if (e.key === 'Escape') close();
    });
    const off = (e) => {
      if (!pop.contains(e.target) && !anchor.contains(e.target)) close();
    };
    document.addEventListener('mousedown', off);
  }

  /* ================= 交互 ================= */
  function focusBranch(name, { toggle = true } = {}) {
    const next = toggle && S.branch === name ? null : name;
    if (next !== S.branch) S.tab = null;
    S.branch = next;
    S.env = null;
    S.who = null;
    // 要看的分支如果在顶部被隐藏了，先把它显示出来
    // 正在看的分支即使没加到顶部栏也临时画出来（drawn() 里算上了 S.branch）
    ctx.setParams({ b: S.branch, who: null, c: null, t: S.tab, env: null });
    drawLeft();
    drawBar();
    compute();
    if (!S.branch) return closeDetail();
    const tip = M.branches.get(S.branch)?.tip ?? -1;
    const r = V.rowOf.get(tip);
    if (r !== undefined) {
      selRow = r;
      scrollToRow(r, true);
    }
    paint(true);
    showBranch(S.branch);
  }

  L.addEventListener('click', (e) => {
    const t = e.target.closest('[data-pin-toggle],[data-env],[data-trunk-tab],[data-add-label],[data-branch],[data-who],[data-stale-toggle]');
    if (!t) return;
    if (t.dataset.pinToggle !== undefined) {
      e.stopPropagation();
      setPinned(t.dataset.pinToggle, !pins().has(t.dataset.pinToggle));
    } else if (t.dataset.env !== undefined) {
      e.stopPropagation();
      openEnv(t.dataset.env);
    } else if (t.dataset.trunkTab !== undefined) {
      e.stopPropagation();
      S.tab = t.dataset.trunkTab;
      const name = t.closest('[data-branch]').dataset.branch;
      if (S.branch === name) {
        ctx.setParams({ t: S.tab });
        showBranch(name);
      } else {
        S.branch = null;
        focusBranch(name);
        S.tab = t.dataset.trunkTab;
        ctx.setParams({ t: S.tab });
        showBranch(name);
      }
    } else if (t.dataset.addLabel !== undefined) {
      e.stopPropagation();
      labelEditor(t, { branch: t.dataset.addLabel });
    } else if (t.dataset.editLabel !== undefined) {
      e.stopPropagation();
      labelEditor(t, { env: C.envs.find((x) => x.id === t.dataset.editLabel) });
    } else if (t.dataset.branch !== undefined) focusBranch(t.dataset.branch);
    else if (t.dataset.who !== undefined) {
      const id = Number(t.dataset.who);
      S.who = S.who === id ? null : id;
      S.branch = null;
      ctx.setParams({ who: S.who, b: null });
      drawLeft();
      drawBar();
      compute();
      paint(true);
    } else if (t.dataset.staleToggle !== undefined) {
      L.dataset.stale = L.dataset.stale === '1' ? '0' : '1';
      drawLeft();
    }
  });

  bar.addEventListener('click', (e) => {
    const th = e.target.closest('[data-toggle-history]');
    const tf = e.target.closest('[data-branch-focus]');
    const md = e.target.closest('[data-mode]');
    const up = e.target.closest('[data-unpin]');
    const pn = e.target.closest('[data-pin]');
    if (up) {
      e.stopPropagation();
      setPinned(up.dataset.unpin, false);
    } else if (pn) setPinned(pn.dataset.pin, true);
    else if (md) {
      // 主线 / 完整：换一种看法，尽量停在原来看的那个提交
      if (H.mode === md.dataset.mode) return;
      H.mode = md.dataset.mode;
      applyHidden();
      const id = S.sel ? M.byHash.get(S.sel) : undefined;
      if (id !== undefined && V.rowOf.has(id)) scrollToRow(V.rowOf.get(id), true);
      paint(true);
    } else if (th) {
      // 完整视图里开关已合并的历史：记住选择，重排提交图，尽量停在原来看的位置
      H.history = !H.history;
      applyHidden();
    } else if (e.target.closest('[data-more-branches]')) openBranchPanel(e.target.closest('[data-more-branches]'));
    else if (tf) focusBranch(tf.dataset.branchFocus);
    else if (e.target.closest('[data-clear]')) {
      S.branch = null;
      S.who = null;
      ctx.setParams({ b: null, who: null });
      drawLeft();
      drawBar();
      compute();
      closeDetail();
    }
  });
  head.addEventListener('click', (e) => {
    const t = e.target.closest('[data-branch-focus]');
    if (!t) return;
    const tab = t.dataset.trunkOpen ?? null;
    if (tab) {
      S.tab = tab;
      S.branch = null;
    }
    focusBranch(t.dataset.branchFocus, { toggle: !tab });
    if (tab) {
      S.tab = tab;
      ctx.setParams({ t: tab });
      showBranch(S.branch);
    }
  });
  bar.addEventListener('input', debounce((e) => {
    if (!e.target.matches('[data-q]')) return;
    S.q = e.target.value;
    ctx.setParams({ q: S.q });
    computeMatches();
    paint(true);
    if (V.match?.length) jump(1, true);
  }, 180));
  bar.addEventListener('keydown', (e) => {
    if (!e.target.matches('[data-q]')) return;
    if (e.key === 'Enter') {
      jump(e.shiftKey ? -1 : 1);
      e.preventDefault();
    } else if (e.key === 'Escape') {
      e.target.value = '';
      e.target.dispatchEvent(new Event('input'));
    }
  });
  function jump(dir, fromTop = false) {
    if (!V.match?.length) return;
    let r;
    if (fromTop) r = V.match.find((x) => x >= Math.max(0, selRow)) ?? V.match[0];
    else if (dir > 0) r = V.match.find((x) => x > selRow) ?? V.match[0];
    else r = [...V.match].reverse().find((x) => x < selRow) ?? V.match.at(-1);
    select(r, { center: true });
    computeMatches();
  }

  body.addEventListener('click', (e) => {
    const ev = e.target.closest('[data-env]');
    if (ev) return openEnv(ev.dataset.env);
    const row = e.target.closest('[data-r]');
    if (!row) return;
    const r = Number(row.dataset.r);
    if (r === selRow && !D.hidden && !S.branch) closeDetail();
    else select(r, { scroll: false });
  });
  list.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'j') { select(Math.min(V.order.length - 1, selRow + 1)); e.preventDefault(); }
    else if (e.key === 'ArrowUp' || e.key === 'k') { select(Math.max(0, selRow - 1)); e.preventDefault(); }
    else if (e.key === 'Escape') D.querySelector('[data-back]') ? showBranch(S.branch) : D.querySelector('[data-back-env]') ? showEnv(S.env) : S.branch ? focusBranch(S.branch) : closeDetail();
  });
  D.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) {
      if (S.branch) focusBranch(S.branch);
      else closeDetail();
    } else if (e.target.closest('[data-etab]')) {
      S.tab = e.target.closest('[data-etab]').dataset.etab;
      ctx.setParams({ t: S.tab });
      showEnv(S.env);
    } else if (e.target.closest('[data-env-edit]')) {
      const b = e.target.closest('[data-env-edit]');
      labelEditor(b, { env: C.envs.find((x) => x.id === b.dataset.envEdit) });
    } else if (e.target.closest('[data-branch-go]')) {
      closeEnv();
      focusBranch(e.target.closest('[data-branch-go]').dataset.branchGo, { toggle: false });
    } else if (e.target.closest('[data-open-settings]')) openSettingsFromLink();
    else if (e.target.closest('[data-copy-list]')) copyText(D._copy());
    else if (e.target.closest('[data-back-env]') && S.env) {
      ctx.setParams({ c: null });
      showEnv(S.env);
    } else if (e.target.closest('[data-ttab]')) {
      S.tab = e.target.closest('[data-ttab]').dataset.ttab;
      ctx.setParams({ t: S.tab });
      showBranch(S.branch);
    } else if (e.target.closest('[data-back]') && S.branch) {
      ctx.setParams({ c: null });
      showBranch(S.branch);
    } else if (e.target.closest('[data-open]')) {
      const c = Number(e.target.closest('[data-open]').dataset.open);
      const r = V.rowOf.get(c);
      if (r !== undefined) {
        selRow = r;
        scrollToRow(r, true);
        paint(true);
      }
      S.sel = M.h[c];
      ctx.setParams({ c: S.sel });
      showCommit(c, S.branch);
    } else if (e.target.closest('[data-copy]')) copyText(e.target.closest('[data-copy]').dataset.copy);
  });

  function reselect(center = true) {
    const id = S.sel ? M.byHash.get(S.sel) : undefined;
    const r = id !== undefined ? V.rowOf.get(id) : undefined;
    if (r !== undefined) select(r, { center });
    else {
      selRow = -1;
      paint(true);
    }
  }

  /* ================= 开始 ================= */
  function all() {
    prepare();
    drawLeft();
    drawBar();
    compute();
  }
  all();
  // 等布局有了高度再定位（刚挂载时列表还没尺寸，居中会算错）
  const start = () => {
    if (!list.clientHeight) return requestAnimationFrame(start);
    if (S.env && C.envs.some((x) => x.id === S.env)) {
      openEnv(S.env, S.tab);
    } else if (S.sel) reselect(true);
    else if (S.branch && M.branches.has(S.branch)) focusBranch(S.branch, { toggle: false });
    else {
      paint(true);
      // 什么都没选：右栏直接打开最新动过的分支（只打开详情，提交图仍是全局，不筛选、不压暗）；
      // 没有进行中的就打开集成分支（看待上线 / 没回合）。只有一条主线时不打开——它的详情和中间的提交列表是重复的
      const latest = C.show.filter((b) => b.status === 'active').sort((x, y) => y.time - x.time)[0]?.name ?? (C.mainName ? C.devName : null);
      // 窄屏时详情是浮层，会盖住提交图，就不自动打开了
      if (latest && M.branches.has(latest) && innerWidth > 1200) showBranch(latest);
    }
  };
  start();
  // 从提示跳过来要打开设置（?settings=1）：打开后把参数去掉，返回不会再弹
  function openSettingsFromLink() {
    ctx.setParams({ settings: null });
    openSettings({ id: ctx.id, name: O.name ?? ctx.id, model: M });
  }
  if (ctx.params.get('settings')) openSettingsFromLink();
  list.focus({ preventScroll: true });
  const off = store.on((what) => {
    if (what === 'worktrees') {
      const top = list.scrollTop;
      compute();
      list.scrollTop = top;
      paint(true);
    } else if (what === 'prs') paint(true);
  });

  return {
    update(params) {
      if (params.get('settings')) return openSettingsFromLink();
      const env = params.get('env') || null;
      if (env && (env !== S.env || (params.get('t') || null) !== S.tab)) return openEnv(env, params.get('t') || null);
      const b = params.get('b') || null;
      const c = params.get('c') || null;
      const t = params.get('t') || null;
      if (b !== S.branch || t !== S.tab) {
        S.tab = t;
        if (b) focusBranch(b, { toggle: false });
        else if (S.branch) focusBranch(S.branch);
      }
      if (c && c !== S.sel) {
        S.sel = c;
        reselect(true);
      }
      const q = params.get('q') || '';
      if (q !== S.q) {
        S.q = q;
        computeMatches();
        paint(true);
      }
    },
    /** 新快照到了：重读提交图，保持滚动位置和选中 */
    async refresh() {
      const top = list.scrollTop;
      await store.loadModel(true).catch(() => null);
      all();
      list.scrollTop = top;
      const id = S.sel ? M.byHash.get(S.sel) : undefined;
      selRow = id !== undefined ? V.rowOf.get(id) ?? -1 : -1;
      paint(true);
    },
    theme() {
      paint(true);
    },
    unmount() {
      ro.disconnect();
      barRo.disconnect();
      off();
      document.querySelector('.lpop')?.remove();
      closePop();
    },
  };
}
