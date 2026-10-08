// 分支页：所有分支一张表——谁的、提交多少、相对集成分支领先 / 落后多少、走到了哪一站、云端 / 本机状态、PR、工单与自定义标签。
// 上面筛选（进行中 / 待上线 / 已上线 / 停滞 / 本机 / 我的）和排序；点一行去分支图并打开这条分支。
import { esc, icon, avatar, ago, when, fullStamp, toast, debounce, closePop, prChip, copyText, tipCard } from '../lib/util.js';
import { request } from '../lib/api.js';
import { branchColor } from '../lib/colors.js';
import { resizer } from '../lib/resize.js';

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'active', label: '进行中', tip: '未合入集成分支' },
  { id: 'pending', label: '已进 dev', tip: '已进集成分支，未进上线分支' },
  { id: 'released', label: '已进 main', tip: '已进上线分支' },
  { id: 'stale', label: '停滞', tip: (o) => `${o.staleDays} 天未更新` },
  { id: 'clean', label: '可清理', tip: '已合入或停滞的分支' },
  { id: 'local', label: '本机', tip: '本机分支' },
  { id: 'mine', label: '我的', tip: '我负责的分支' },
];

export function mount(el, ctx) {
  const { store } = ctx;
  let f = ctx.params.get('f') || 'active';
  let q = ctx.params.get('q') || '';
  let sort = ctx.params.get('s') || 'time';
  let picks = null; // 可清理：勾选了哪些（第一次进入时默认勾上已合并的）
  /** 能清理：合进主线了（自己没有提交）或停滞；打开着 PR 的、本机正检出着的不算 */
  const cleanable = (r) => r.cloud && (r.status === 'merged' || r.status === 'released' || r.status === 'stale') && !(r.pr && (r.pr.state === 'OPEN' || r.pr.state === 'DRAFT')) && !r.local?.checkedOut?.length;
  const RECENT = 3 * 86400;

  el.innerHTML = '<div class="page" data-scroll><div class="bpage" data-root></div></div>';
  const root = el.querySelector('[data-root]');
  const scroller = el.querySelector('[data-scroll]');

  /** 全部分支（云端的 + 只在本机的），带上云端 / 本机状态 */
  function rows() {
    const o = ctx.overview;
    const M = store.model;
    const localBy = new Map();
    for (const b of o.local?.branches ?? []) {
      const k = b.cloudName ?? b.name;
      if (!localBy.has(k)) localBy.set(k, b);
    }
    const dirtyBy = new Map();
    for (const c of o.local?.checkouts ?? []) if (c.branch && c.total && !c.temp) dirtyBy.set(c.branch, (dirtyBy.get(c.branch) ?? 0) + c.total);
    const out = o.branches.map((b) => ({ ...b, cloud: true, local: localBy.get(b.name) ?? null, dirty: dirtyBy.get(b.name) ?? 0 }));
    const cloudNames = new Set(out.map((b) => b.name));
    for (const lb of o.local?.branches ?? []) {
      // 只在本机、云端没有的分支（没推送过的）
      if (cloudNames.has(lb.name) || lb.cloudExists !== false || !(lb.unpushed > 0)) continue;
      cloudNames.add(lb.name);
      out.push({ name: lb.name, cloud: false, local: lb, dirty: dirtyBy.get(lb.name) ?? 0, own: lb.unpushed, behind: null, status: 'localonly', owner: null, time: lb.time, tip: { subject: lb.subject }, tickets: [], pr: null, people: [] });
    }
    const trunk = { main: M.trunk.prod, dev: M.trunk.dev };
    for (const r of out) {
      r.color = branchColor(r.name, trunk);
      r.tags = o.branchTags?.[r.name] ?? [];
    }
    return out;
  }

  function stops() {
    const M = store.model;
    const out = [];
    const add = (name, tip, color, env) => tip >= 0 && out.push({ name, tip, color, env });
    const devTip = M.trunk.dev ? M.branches.get(M.trunk.dev)?.tip ?? -1 : -1;
    const mainTip = M.trunk.prod ? M.branches.get(M.trunk.prod)?.tip ?? -1 : -1;
    const envAt = (branch) => (M.raw.envs ?? []).filter((e) => e.branch === branch && e.commit && !e.assumed).map((e) => ({ name: e.name, tip: M.byHash.get(e.commit) ?? -1 }));
    add(M.trunk.dev, devTip, 'var(--s2)', false);
    for (const e of envAt(M.trunk.dev)) add(e.name, e.tip, 'var(--s2)', true);
    add(M.trunk.prod, mainTip, 'var(--s1)', false);
    for (const e of envAt(M.trunk.prod)) add(e.name, e.tip, 'var(--s1)', true);
    return out;
  }
  function journey(r, st) {
    const M = store.model;
    const tip = r.cloud ? M.branches.get(r.name)?.tip ?? -1 : -1;
    if (tip < 0) return '<span class="jy faint" data-tip="仅本机">—</span>';
    const on = st.map((s) => M.isAncestor(tip, s.tip));
    const card = tipCard({ title: '进度', dots: st.map((s, i) => ({ on: on[i], c: s.color, env: s.env, label: `${s.name}${on[i] ? '' : '（未到）'}` })) });
    return `<span class="jy" data-tip-html data-tip="${esc(card)}">${st.map((s, i) => `<i class="${on[i] ? 'on' : ''}${s.env ? ' e' : ''}" style="--c:${s.color}"></i>`).join('')}</span>`;
  }

  function filtered(all) {
    const me = ctx.me?.();
    const ql = q.trim().toLowerCase();
    const persons = ctx.overview.persons;
    let list = all.filter((r) => {
      if (f === 'active' && r.status !== 'active') return false;
      if (f === 'pending' && r.status !== 'merged') return false;
      if (f === 'released' && r.status !== 'released') return false;
      if (f === 'stale' && r.status !== 'stale') return false;
      if (f === 'local' && !r.local) return false;
      if (f === 'clean' && !cleanable(r)) return false;
      if (f === 'mine' && (me == null || r.owner !== me)) return false;
      if (ql) {
        const hay = [r.name, persons[r.owner]?.name, r.tip?.subject, ...(r.tickets ?? []), ...r.tags, r.pr ? '#' + r.pr.n : ''].join(' ').toLowerCase();
        if (!hay.includes(ql)) return false;
      }
      return true;
    });
    list = list.sort(sort === 'commits' ? (x, y) => (y.own ?? 0) - (x.own ?? 0) || y.time - x.time : (x, y) => y.time - x.time);
    return list;
  }

  function counts(all) {
    const me = ctx.me?.();
    return {
      all: all.length,
      active: all.filter((r) => r.status === 'active').length,
      pending: all.filter((r) => r.status === 'merged').length,
      released: all.filter((r) => r.status === 'released').length,
      stale: all.filter((r) => r.status === 'stale').length,
      local: all.filter((r) => r.local).length,
      clean: all.filter(cleanable).length,
      mine: me == null ? 0 : all.filter((r) => r.owner === me).length,
    };
  }

  function cloudIcon(r) {
    return r.cloud
      ? `<span class="st-ic on" data-tip="云端">${icon.cloud(13)}</span>`
      : `<span class="st-ic warn" data-tip="云端没有">${icon.cloud(13)}<i class="x"></i></span>`;
  }
  function localIcon(r) {
    if (!r.local) return `<span class="st-ic off" data-tip="本机没有">${icon.desktop(13)}</span>`;
    const L = r.local;
    const bits = [];
    if (L.unpushed > 0) bits.push(`<b class="w">${icon.arrowUp(9)}${L.unpushed}</b>`);
    if (L.behind > 0) bits.push(`<b>${icon.arrowDown(9)}${L.behind}</b>`);
    if (r.dirty) bits.push(`<b>${icon.pencil(9)}${r.dirty}</b>`);
    const tip = ['本机', L.checkedOut?.length ? '已检出' : '', L.unpushed > 0 ? `未推送 ${L.unpushed}` : '', L.behind > 0 ? `未拉取 ${L.behind}` : '', r.dirty ? `${r.dirty} 个文件未提交` : '', !bits.length ? '与云端一致' : ''].filter(Boolean).join(' · ');
    return `<span class="st-ic on${L.unpushed > 0 ? ' warnc' : ''}" data-tip="${esc(tip)}">${icon.desktop(13)}${bits.join('')}</span>`;
  }

  function render() {
    const o = ctx.overview;
    const all = rows();
    const n = counts(all);
    const list = filtered(all);
    const st = stops();
    const persons = o.persons;
    const devName = store.model.trunk.dev ?? store.model.trunk.prod;
    root.innerHTML = `
      <div class="btools">
        <div class="fchips">${FILTERS.map((x) => `<button class="chip${f === x.id ? ' on' : ''}${!n[x.id] && x.id !== 'all' ? ' zero' : ''}" data-f="${x.id}" ${x.tip ? `data-tip="${esc(typeof x.tip === 'function' ? x.tip(o) : x.tip)}"` : ''}>${x.label}<span class="n">${n[x.id]}</span></button>`).join('')}</div>
        <span class="grow"></span>
        <div class="seg" data-tip="排序"><button data-s="time" aria-pressed="${sort === 'time'}">${icon.clock(12)}</button><button data-s="commits" aria-pressed="${sort === 'commits'}">${icon.commit(12)}</button></div>
        <label class="field sm">${icon.search(12)}<input data-q value="${esc(q)}" placeholder="分支、成员、工单、标签"></label>
      </div>
      ${f === 'clean' ? cleanBar(list) : trunkCard()}
      <div class="bl card${f === 'clean' ? ' picking' : ''}">
        <div class="bl-h"><span>分支</span><span><i data-col="1"></i>负责人</span><span data-tip="云端 · 本机"><i data-col="2"></i>状态</span><span data-tip="${esc(`提交 / 落后 ${devName}`)}"><i data-col="3"></i>对 ${esc(devName ?? '')}</span><span data-tip="${esc(st.map((s) => s.name).join(' → '))}"><i data-col="4"></i>走到</span><span><i data-col="5"></i>更新</span><span></span></div>
        ${list.map((r) => {
          const p = r.owner != null ? persons[r.owner] : null;
          const tags = [
            ...(r.tickets ?? []).slice(0, 2).map((t) => `<span class="ttag">${esc(t)}</span>`),
            ...r.tags.map((t) => `<span class="utag" data-tag="${esc(t)}" data-tip="标签">${esc(t)}<i data-untag="${esc(t)}">×</i></span>`),
            r.pr ? prChip(r.pr) : '',
            r.status === 'stale' ? `<span class="stag" data-tip="停滞（${o.staleDays} 天）">${icon.clock(10)}</span>` : '',
          ].join('');
          return `<div class="bl-r" data-open="${esc(r.name)}" style="--c:${r.color}">
            <span class="bn2">${f === 'clean' ? `<input type="checkbox" data-pick="${esc(r.name)}" ${picks?.has(r.name) ? 'checked' : ''}>` : ''}<i class="dot"></i><span class="nm" data-tip-c="${r.color}" data-tip="${esc(`${r.name}\n${ctx.overview.persons[r.owner]?.name ?? ''}${r.tip?.subject ? `\n最新：${r.tip.subject}` : ''}`)}">${esc(r.name)}</span>${tags}<button class="addtag" data-addtag="${esc(r.name)}" data-tip="加标签">${icon.tag(11)}</button></span>
            <span class="ow">${p ? `${avatar(p, 18)}<span>${esc(p.name)}</span>` : '<span class="faint">—</span>'}</span>
            <span class="sti">${cloudIcon(r)}${localIcon(r)}</span>
            <span class="ab">${r.own != null ? `<span class="up" data-tip="提交">${icon.arrowUp(9)}${r.own}</span>` : ''}${r.behind != null ? `<span class="${r.behind ? 'down' : 'zero'}" data-tip="${esc(`落后 ${devName}`)}">${icon.arrowDown(9)}${r.behind}</span>` : ''}</span>
            <span>${journey(r, st)}</span>
            <span class="t" data-tip="${fullStamp(r.time)}">${when(r.time)}</span>
            <span class="go-r">${icon.chevronRight(12)}</span>
          </div>`;
        }).join('') || `<div class="quiet pad">${icon.check(14)} 没有符合的分支</div>`}
      </div>`;
    // 表头每列左边的分界都能拖：往右拖 = 这一列变窄、分支名那列变宽（列宽记在浏览器里，所有项目共用）
    const DEF = [0, 130, 92, 88, 76, 84];
    for (const h of root.querySelectorAll('.bl-h [data-col]')) {
      const i = Number(h.dataset.col);
      resizer(h, { target: root, prop: `--bc${i}`, key: `branches-col${i}`, min: 40, max: 360, dir: -1, def: DEF[i] });
    }
  }

  /** 两条主线直接比：待上线（集成分支有、上线分支没有）、没回合（上线分支有、集成分支没有），点了去分支图看明细 */
  function trunkCard() {
    const T = ctx.overview.trunk;
    if (!T) return '';
    if (!T.ahead.count && !T.behind.count) return `<div class="tsame">${icon.check(13)}<i style="--c:var(--s2)"></i>${esc(T.dev)}<span>和</span><i style="--c:var(--s1)"></i>${esc(T.main)}<span>一致</span></div>`;
    const persons = ctx.overview.persons;
    const side = (k, pk, title, tip, color, warn) => `<a class="tside${warn && pk.count ? ' warn' : ''}" href="${ctx.href('graph', { b: k === 'ahead' ? T.dev : T.main, t: k })}" data-tip="${esc(tip)}">
        <span class="tt">${k === 'ahead' ? `<i style="--c:var(--s2)"></i>${esc(T.dev)}${icon.arrowRight(11)}<i style="--c:var(--s1)"></i>${esc(T.main)}` : `<i style="--c:var(--s1)"></i>${esc(T.main)}${icon.arrowRight(11)}<i style="--c:var(--s2)"></i>${esc(T.dev)}`}</span>
        <span class="tn">${pk.count || icon.check(14)}</span>
        <span class="tl">${title}${pk.oldest && pk.count ? ` · 最早 ${ago(pk.oldest)}` : ''}</span>
        <span class="tp">${pk.people.slice(0, 5).map((x) => `<span class="pc" data-tip="${esc(`${persons[x.id]?.name ?? '?'}：${x.n} 个`)}">${avatar(persons[x.id], 18)}</span>`).join('')}</span>
      </a>`;
    return `<div class="tcard card">
      ${side('ahead', T.ahead, '待上线', `${T.dev} → ${T.main}`, 'var(--s2)', false)}
      ${side('behind', T.behind, '没回合', `${T.main} → ${T.dev}`, 'var(--s1)', true)}
    </div>`;
  }

  /** 可清理：说明 + 复制删除命令。BranchMap 只读，不替你删 */
  function cleanBar(list) {
    // 默认勾上：已合并、且 3 天没动的（刚合并的可能还有人要用）
    if (!picks) picks = new Set(list.filter((r) => r.status !== 'stale' && Date.now() / 1000 - r.time > RECENT).map((r) => r.name));
    const chosen = list.filter((r) => picks.has(r.name));
    const merged = list.filter((r) => r.status !== 'stale').length;
    const local = chosen.filter((r) => r.local);
    return `<div class="cbar card">
      <div class="cb1">${icon.archive(16)}<span><b>${merged}</b> 条已合入${list.length - merged ? ` · <b>${list.length - merged}</b> 条停滞` : ''}</span><span class="grow"></span>
        <button class="btn sm" data-pick-all data-tip="全选 / 全不选">${chosen.length === list.length && list.length ? '全不选' : '全选'}</button>
        <button class="btn sm primary" data-copy-cmd="cloud" ${chosen.length ? '' : 'disabled'} data-tip="${esc('git push origin --delete …')}">${icon.copy(12)} 云端命令 ${chosen.length}</button>
        <button class="btn sm" data-copy-cmd="local" ${local.length ? '' : 'disabled'} data-tip="${esc('git branch -d …')}">${icon.desktop(12)} 本机命令 ${local.length}</button>
      </div>
      <div class="cb2 muted">复制命令后在终端执行</div>
    </div>`;
  }

  function tagEditor(anchor, branch) {
    closePop();
    document.querySelector('.lpop')?.remove();
    const pop = document.createElement('div');
    pop.className = 'pop lpop';
    pop.innerHTML = `<input class="lin" placeholder="发布候选、阻塞、需评审…" maxlength="16"><div class="lrow"><span class="grow"></span><button class="btn primary sm" data-ok>${icon.check(12)}</button></div>`;
    document.body.append(pop);
    const rc = anchor.getBoundingClientRect();
    pop.style.left = Math.min(rc.left, innerWidth - 300) + 'px';
    pop.style.top = rc.bottom + 6 + 'px';
    const input = pop.querySelector('input');
    setTimeout(() => input.focus(), 0);
    const close = () => {
      pop.remove();
      document.removeEventListener('mousedown', off);
    };
    const save = async () => {
      const t = input.value.trim();
      if (!t) return close();
      await setTags(branch, [...(ctx.overview.branchTags?.[branch] ?? []), t]);
      close();
    };
    pop.addEventListener('click', (e) => e.target.closest('[data-ok]') && save());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') close();
    });
    const off = (e) => {
      if (!pop.contains(e.target)) close();
    };
    document.addEventListener('mousedown', off);
  }
  async function setTags(branch, tags) {
    try {
      await request(`/api/p/${encodeURIComponent(ctx.id)}/branch-tags`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ branch, tags }) });
    } catch (e) {
      toast(e.message);
    }
  }

  root.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('a')) return;
    const fb = t.closest('[data-f]');
    if (fb) {
      f = fb.dataset.f;
      ctx.setParams({ f: f === 'active' ? null : f });
      return render();
    }
    const sb = t.closest('[data-s]');
    if (sb) {
      sort = sb.dataset.s;
      ctx.setParams({ s: sort === 'time' ? null : sort });
      return render();
    }
    const pk = t.closest('[data-pick]');
    if (pk) {
      pk.checked ? picks.add(pk.dataset.pick) : picks.delete(pk.dataset.pick);
      return render();
    }
    if (t.closest('[data-pick-all]')) {
      const list = filtered(rows());
      const allOn = list.every((r) => picks.has(r.name));
      picks = new Set(allOn ? [] : list.map((r) => r.name));
      return render();
    }
    const cc = t.closest('[data-copy-cmd]');
    if (cc) {
      const chosen = filtered(rows()).filter((r) => picks.has(r.name));
      const q = (n) => (/^[\w./-]+$/.test(n) ? n : `"${n}"`);
      const cmd = cc.dataset.copyCmd === 'cloud' ? `git push origin --delete ${chosen.map((r) => q(r.name)).join(' ')}` : `git branch -d ${chosen.filter((r) => r.local).map((r) => q(r.local.name)).join(' ')}`;
      return copyText(cmd);
    }
    const ut = t.closest('[data-untag]');
    if (ut) {
      const row = ut.closest('[data-open]');
      const b = row.dataset.open;
      return setTags(b, (ctx.overview.branchTags?.[b] ?? []).filter((x) => x !== ut.dataset.untag));
    }
    const at = t.closest('[data-addtag]');
    if (at) return tagEditor(at, at.dataset.addtag);
    const row = t.closest('[data-open]');
    if (row) location.hash = ctx.href('graph', { b: row.dataset.open });
  });
  root.addEventListener('input', debounce((e) => {
    if (!e.target.matches('[data-q]')) return;
    q = e.target.value;
    ctx.setParams({ q });
    const pos = e.target.selectionStart;
    render();
    const inp = root.querySelector('[data-q]');
    inp.focus();
    inp.setSelectionRange(pos, pos);
  }, 200));

  render();
  return {
    update(params) {
      f = params.get('f') || 'active';
      render();
    },
    async refresh() {
      const top = scroller.scrollTop;
      await store.loadModel().catch(() => null);
      render();
      scroller.scrollTop = top;
    },
    unmount() {
      document.querySelector('.lpop')?.remove();
    },
  };
}
