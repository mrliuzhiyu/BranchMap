// 分支图：一个项目的全部，一层一层往下看。
//   左：main / dev 两条主线（带「生产」「测试」这类环境标签，可以加）+ 按人列出的分支，颜色和图上一致
//   中：提交图。main、dev 是两条贯穿全图的粗轨道；每条分支有自己的颜色；合并完的历史是灰色
//   右：第二层——点分支：它是谁的、走到哪了、它自己的提交；第三层——点提交：走到哪了、改了哪些文件（可返回分支）
// 能用图形表达的就不写字；解释都放在悬停提示里。
import { esc, icon, avatar, ago, when, fullStamp, toast, copyText, closePop, debounce, lineStat, fileName, prChip, picker } from '../lib/util.js';
import { layout, segPath, TRUNKS } from '../lib/layout.js';
import { openChanges } from '../lib/changes.js';
import { commitChangesLoader } from '../lib/commitview.js';
import { has } from '../lib/model.js';
import { MAIN, DEV, HIST, branchColor } from '../lib/colors.js';
import { openSettings } from '../lib/settings.js';

const RH = 30;
const LW = 14;
const PAD = 14;
const MAX_LANES = 8; // 更多的泳道收进最右一条，给提交说明留位置
const OVERSCAN = 12;
const RECENT_MERGED = 7 * 86400;

/** 合并提交的说明里，被合进来的是哪条分支（认不出返回 null）。 */
function mergedFrom(s) {
  let m = /^Merge pull request #\d+ from [^/\s]+\/(\S+)/.exec(s);
  if (m) return m[1];
  m = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(s);
  return m ? m[1].replace(/^origin\//, '') : null;
}

/** 顶部分支开关（隐藏了哪些）按项目记在浏览器里。 */
function loadHidden(id) {
  try {
    const v = JSON.parse(localStorage.getItem('bm-hidden:' + id) ?? 'null');
    return { branches: new Set(v?.branches ?? []), history: v?.history ?? true };
  } catch {
    return { branches: new Set(), history: true };
  }
}
function saveHidden(id, h) {
  try {
    localStorage.setItem('bm-hidden:' + id, JSON.stringify({ branches: [...h.branches], history: h.history }));
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
      <div class="glist" tabindex="0"><div class="gbody"></div></div>
    </section>
    <aside class="dcol" data-d hidden></aside>
  </div>`;
  const L = el.querySelector('[data-l]');
  const bar = el.querySelector('[data-bar]');
  const list = el.querySelector('.glist');
  const body = el.querySelector('.gbody');
  const D = el.querySelector('[data-d]');

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
    // 已经合并完的历史：按它当初是从哪条分支合进来的上色（画得淡一些）；认不出来源的才是灰色
    const merged = new Map(); // 分支名 -> 提交数
    for (const tip of [devTip, mainTip]) {
      if (tip < 0) continue;
      const T = M.trunkInfo(tip);
      for (let c = 0; c < M.N; c++) {
        if (key[c] !== 'hist' || T.intro[c] < 0) continue;
        const n = mergedFrom(M.s[T.chain[T.intro[c]]]);
        if (!n || n === mainName || n === devName) continue;
        key[c] = 'h:' + n;
        merged.set(n, (merged.get(n) ?? 0) + 1);
        if (!colorOf.has('h:' + n)) colorOf.set('h:' + n, branchColor(n));
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
    C = { mainName, devName, mainTip, devTip, key, colorOf, show, stale, owned, envs, envAt, trunkSet, merged };
  }
  const colorFor = (k) => C.colorOf.get(k) ?? 'var(--hist)';
  const keyOfBranch = (name) => (name === C.mainName ? 'main' : name === C.devName ? 'dev' : 'b:' + name);
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
    return `<span class="jy" data-tip="${esc(st.map((s) => `${M.isAncestor(c, s.tip) ? '●' : '○'} ${s.name}`).join('\n'))}">${st.map((s) => `<i class="${M.isAncestor(c, s.tip) ? 'on' : ''}${s.env ? ' e' : ''}" style="--c:${colorFor(s.k)}"></i>`).join('')}</span>`;
  }
  function stepsHtml(c) {
    const st = stops();
    if (!st.length) return '';
    return `<div class="steps">${st.map((s) => {
      const on = M.isAncestor(c, s.tip);
      const tip = s.env ? `环境「${s.name}」：${on ? '已经部署了这个提交' : '还没部署到这里'}` : `分支 ${s.name}：${on ? '已经合进来了' : '还没合进来'}`;
      return `<div class="step${on ? ' on' : ''}${s.env ? ' is-env' : ''}" style="--c:${colorFor(s.k)}" data-tip="${esc(tip)}"><i>${s.env ? icon.server(8) : ''}</i><span>${esc(s.name)}</span></div>`;
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
    return `<span class="env${e.assumed ? ' assumed' : ''}${e.state === 'down' ? ' down' : ''}" style="--c:${color}" data-env="${esc(e.id)}" data-tip="${esc(tip)}">${icon.server(9)}${esc(e.name)}</span>`;
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
      return `<div class="rail-row${S.branch === name ? ' on' : ''}" data-branch="${esc(name)}" style="--c:${colorFor(k)}">
        <i class="rbar"></i><span class="rname">${esc(name)}</span>
        ${C.envs.filter((e) => e.branch === name).map((e) => envPill(e, k, true)).join('')}
        <button class="add" data-add-label="${esc(name)}" data-tip="加环境标签">${icon.tag(12)}</button>
        <span class="grow"></span>${loc(localBy.get(name))}${gap}
      </div>`;
    };
    const branchRow = (b) => {
      const tip = M.branches.get(b.name).tip;
      const merged = b.status === 'merged' || b.status === 'released';
      return `<div class="br-row${S.branch === b.name ? ' on' : ''}${merged ? ' merged' : ''}" data-branch="${esc(b.name)}" style="--c:${colorFor('b:' + b.name)}" data-tip="${esc(`${b.name}\n${ago(b.time)}`)}">
        <i class="dot"></i><span class="bname">${esc(b.name)}</span>${b.pr ? prChip(b.pr, { mini: true }) : ''}${(O.branchTags?.[b.name] ?? []).slice(0, 2).map((t) => `<span class="utag sm">${esc(t)}</span>`).join('')}${loc(localBy.get(b.name))}
        ${merged ? journey(tip) : `<span class="own" data-tip="自己的提交">+${b.own}</span>`}
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
        ${C.stale.length ? `<button class="more" data-stale-toggle data-tip="超过 30 天没动、也没合进主线">${staleOpen ? icon.chevronDown(11) : icon.chevronRight(11)}${icon.clock(11)}<span>${C.stale.length}</span></button>${staleOpen ? C.stale.map(branchRow).join('') : ''}` : ''}
      </div>`;
  }

  /* ================= 中间：提交图 ================= */
  function drawBar() {
    const chip = S.branch
      ? `<i class="dot" style="background:${colorFor(keyOfBranch(S.branch))}"></i>${esc(S.branch)}`
      : S.who != null ? `${avatar(O.persons[S.who], 16)}${esc(O.persons[S.who]?.name ?? '')}` : '';
    // 分支开关：主线固定显示（点一下看它的详情）；其余分支点一下隐藏 / 显示；最后是「已合并」的历史
    const trunkChip = (name, k) => (name ? `<button class="bchip trunk" data-branch-focus="${esc(name)}" style="--c:${colorFor(k)}" data-tip="${esc(`${name}：主线，一直显示；点一下看它的详情`)}"><i></i>${esc(name)}</button>` : '');
    const chips = C.show.map((b) => {
      const off = H.branches.has(b.name);
      return `<button class="bchip${off ? ' off' : ''}" data-toggle-branch="${esc(b.name)}" style="--c:${colorFor('b:' + b.name)}" data-tip="${esc(`${b.name}\n${O.persons[b.owner]?.name ?? ''} · ${ago(b.time)}\n点一下${off ? '显示' : '隐藏'}`)}"><i></i>${esc(b.name.length > 22 ? b.name.slice(0, 21) + '…' : b.name)}</button>`;
    }).join('');
    const mergedN = [...C.merged.values()].reduce((a, b) => a + b, 0);
    bar.innerHTML = `
      <label class="gsearch" data-tip="搜提交说明、哈希、作者（回车跳到下一个）">${icon.search(13)}<input data-q value="${esc(S.q)}" autocomplete="off"><span class="count" data-qcount></span></label>
      ${chip ? `<button class="chipx" data-clear data-tip="取消筛选">${chip}${icon.close(11)}</button>` : ''}
      <div class="bchips" data-chips>
        ${trunkChip(C.mainName, 'main')}${trunkChip(C.devName, 'dev')}
        ${chips ? `<span class="bsep"></span>${chips}` : ''}
      </div>
      ${C.show.length + C.stale.length ? '<button class="bchip bmore" data-more-branches data-pop-anchor></button>' : ''}
      <span class="bsep"></span>
      <button class="bchip hist${H.history ? '' : ' off'}" data-toggle-history data-tip="${esc(`已经合并完的历史（${C.merged.size} 条分支、${mergedN} 个提交），颜色按来源分支、画得淡一些\n点一下${H.history ? '隐藏' : '显示'}`)}"><i></i>已合并</button>`;
    fitChips();
  }

  /** 分支多了一行放不下：放得下几个就平铺几个，其余收进「+N」；没收起时按钮上是分支总数。点开都是同一个勾选面板。 */
  function fitChips() {
    const box = bar.querySelector('[data-chips]');
    const more = bar.querySelector('[data-more-branches]');
    if (!box || !more) return;
    const chips = [...box.querySelectorAll('[data-toggle-branch]')];
    const sep = box.querySelector('.bsep');
    for (const c of chips) c.hidden = false;
    if (sep) sep.hidden = false;
    let folded = 0;
    // 从后往前收，直到放得下（两条主线永远在）
    for (let i = chips.length - 1; i >= 0 && box.scrollWidth > box.clientWidth + 1; i--) {
      chips[i].hidden = true;
      folded++;
    }
    if (sep && chips.length && folded === chips.length) sep.hidden = true;
    const total = C.show.length + C.stale.length;
    const off = [...C.show, ...C.stale].filter((b) => H.branches.has(b.name)).length;
    more.classList.toggle('folded', folded > 0);
    more.innerHTML = folded ? `<span>+${folded}</span>${icon.chevronDown(11)}` : `${icon.branch(12)}<span>${total}</span>${icon.chevronDown(11)}`;
    more.dataset.tip = [folded ? `还有 ${folded} 条分支没放下` : `全部 ${total} 条分支`, off ? `隐藏了 ${off} 条` : '', '点开勾选要在图上显示的分支'].filter(Boolean).join('\n');
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
    if (C.stale.length) ordered.push(['停滞（30 天没动）', [...C.stale]]);
    const all = ordered.flatMap(([, bs]) => bs.map((b) => b.name));
    const items = ordered.flatMap(([g, bs]) => bs.sort((x, y) => y.time - x.time).map((b) => ({
      value: b.name,
      label: `${b.name} ${persons[b.owner]?.name ?? ''}`, // 只用来搜索：分组标题里已经有人名了
      group: g,
      html: `<i class="dot" style="background:${colorFor('b:' + b.name)}"></i><span class="ell mono">${esc(b.name)}</span><span class="faint" style="margin-left:auto;font-size:11px;flex:none">${ago(b.time)}</span>`,
    })));
    const pop = picker(anchor, {
      items,
      multi: true,
      selected: all.filter((n) => !H.branches.has(n)),
      placeholder: '搜分支或成员',
      width: 340,
      footer: `<button class="btn sm ghost" data-show-all>全部显示</button><button class="btn sm ghost" data-clear>全部隐藏</button><span class="grow"></span><button class="btn sm" data-done>完成</button>`,
      onPick: (sel) => {
        const on = new Set(sel);
        for (const n of all) on.has(n) ? H.branches.delete(n) : H.branches.add(n);
        applyHidden();
      },
    });
    pop.querySelector('[data-show-all]').addEventListener('click', () => {
      for (const n of all) H.branches.delete(n);
      applyHidden();
      openBranchPanel(bar.querySelector('[data-more-branches]') ?? anchor);
    });
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
    if (k.startsWith('b:')) return !H.branches.has(k.slice(2));
    return H.history;
  }

  function compute() {
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
    let focusKey = null;
    if (S.branch) focusKey = keyOfBranch(S.branch);
    const focus = focusKey ? (id) => id < M.N && C.key[id] === focusKey : S.who != null ? (id) => id < M.N && M.a[id] === S.who : null;
    V = { order, rows: Lr.rows, width: Math.min(Math.max(Lr.width, 2), MAX_LANES), wips: wipBy, rowOf, focus, focusKey };
    V.gw = PAD * 2 + (V.width - 1) * LW;
    list.style.setProperty('--gw', V.gw + 'px');
    body.style.height = order.length * RH + 'px';
    computeMatches();
    painted = { first: -1, last: -1 };
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

  const lx = (l) => PAD + l * LW;
  const isRail = (s) => s[0] === s[2] && s[0] <= 1 && TRUNKS.has(s[4]);

  function labels(id) {
    const out = [];
    for (const e of C.envAt.get(id) ?? []) out.push(envPill(e, railOf(e)));
    for (const r of M.refsAt.get(id) ?? []) {
      if (r.kind !== 'R') continue;
      const n = r.short ?? r.name;
      const k = n === C.mainName ? 'main' : n === C.devName ? 'dev' : C.colorOf.has('b:' + n) ? 'b:' + n : null;
      if (!k) continue;
      const here = M.worktrees.filter((w) => w.branch === n);
      out.push(`<span class="bn${TRUNKS.has(k) ? ' trunk' : ''}" style="--c:${colorFor(k)}" data-tip="${esc(`${n}${here.length ? '\n本机检出：' + here.map((w) => w.path).join('，') : ''}`)}">${icon.cloud(11)}${esc(n)}${here.length ? icon.desktop(10) : ''}</span>`);
    }
    return out.join('');
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
    const cls = `gr${selRow === r ? ' sel' : ''}${dim ? ' dim' : ''}${V.matchSet?.has(r) ? ' match' : ''}${M.P[id].length > 1 ? ' merge' : ''}${TRUNKS.has(C.key[id]) ? ' trunk' : ''}`;
    return `<div class="${cls}" data-r="${r}" style="${style}"><div class="gg"></div><div class="gm">${labels(id)}<span class="gs">${esc(M.s[id])}</span></div><div class="ga" data-tip="${esc(p?.name ?? '')}">${avatar(p, 18)}</div><div class="gt" data-tip="${fullStamp(M.t[id])}">${when(M.t[id])}</div></div>`;
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
      const faded = k === 'hist' || k.startsWith('h:');
      const op = V.focus && !V.focus(id) ? 0.22 : faded ? 0.55 : 1;
      const o = op < 1 ? ` opacity="${op}"` : '';
      const rr = TRUNKS.has(k) ? 5.5 : faded ? 3.5 : 4.5;
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
      const op = V.focusKey && k !== V.focusKey ? 0.22 : k === 'hist' || k.startsWith('h:') ? 0.5 : 1;
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
    let html = svgHtml(first, last);
    for (let r = first; r < last; r++) html += rowHtml(r);
    body.innerHTML = html;
  }
  let raf = 0;
  list.addEventListener('scroll', () => {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); });
  });
  const ro = new ResizeObserver(() => paint(true));
  ro.observe(list);
  const barRo = new ResizeObserver(() => fitChips());
  barRo.observe(bar);

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
    } else commits = [...(C.owned.get(name) ?? [])].sort((x, y) => x - y).slice(0, 80);
    D.hidden = false;
    D.innerHTML = `${dtop(null)}
      <div class="bhead" style="--c:${colorFor(k)}"><i class="${TRUNKS.has(k) ? 'rbar' : 'dot'}"></i><h3>${esc(name)}</h3>${(O.branchTags?.[name] ?? []).map((t) => `<span class="utag">${esc(t)}</span>`).join('')}${C.envs.filter((e) => e.branch === name).map((e) => envPill(e, TRUNKS.has(k) ? k : null)).join('')}
        ${M.raw.slug ? `<a class="icon-btn" href="https://github.com/${esc(M.raw.slug)}/tree/${encodeURIComponent(name)}" target="_blank" rel="noreferrer" data-tip="在 GitHub 打开">${icon.ext(12)}</a>` : ''}</div>
      <div class="dmeta">${avatar(owner, 20)}<span>${esc(owner?.name ?? '')}</span><span class="muted" data-tip="${fullStamp(M.ct[tip])}">${ago(M.ct[tip])}</span>${b ? `<span class="muted" data-tip="${esc(`自己的提交 ${b.own} 个；${C.devName ?? C.mainName ?? '主线'} 比它多 ${b.behind ?? 0} 个`)}">${icon.arrowUp(10)}${b.own} ${icon.arrowDown(10)}${b.behind ?? 0}</span>` : ''}</div>
      ${stepsHtml(tip)}
      ${b?.pr ? prChip(b.pr, { full: true }) : ''}
      ${isTrunkPair ? trunkTabs(name, tip) : `<div class="clist">${commits.map(crow).join('') || `<div class="quiet">${icon.check(12)} 已经全部合进主线</div>`}</div>`}`;
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
      ${pr ? `<a class="dpr" href="${esc(pr.url)}" target="_blank" rel="noreferrer">${icon.pr(12)}#${pr.n} ${esc(pr.title)}</a>` : ''}
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
    if (S.branch && H.branches.delete(S.branch)) saveHidden(ctx.id, H);
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
    const t = e.target.closest('[data-env],[data-trunk-tab],[data-add-label],[data-branch],[data-who],[data-stale-toggle]');
    if (!t) return;
    if (t.dataset.env !== undefined) {
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
    const tb = e.target.closest('[data-toggle-branch]');
    const th = e.target.closest('[data-toggle-history]');
    const tf = e.target.closest('[data-branch-focus]');
    if (tb || th) {
      // 开关一条分支 / 已合并的历史：记住选择，重排提交图，尽量停在原来看的位置
      if (tb) {
        const n = tb.dataset.toggleBranch;
        H.branches.has(n) ? H.branches.delete(n) : H.branches.add(n);
      } else H.history = !H.history;
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
    else paint(true);
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
