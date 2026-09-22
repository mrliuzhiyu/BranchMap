// 文件页：任意分支 / 标签 / 提交时的文件树；右边看文件内容、这个文件的历史（每次改了什么）、逐行追溯（blame）。
import { esc, icon, avatar, ago, stamp, when, num, lineStat, picker, debounce, IMAGE_EXT, nowSec, DAY } from '../lib/util.js';
import { renderFileHtml, mountDiff, langOf, ensureLang, highlightLines } from '../lib/code.js';

const size = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function mount(el, ctx) {
  const { model: M, store } = ctx;
  let ref = ctx.params.get('ref') || M.head || M.trunk.dev || M.trunk.prod || M.h[0];
  let path = ctx.params.get('path') || '';
  let view = ctx.params.get('v') || 'content';
  let hc = ctx.params.get('hc') || null; // 历史里选中的提交
  let filter = '';
  let tree = null;
  let expanded = new Set();
  let token = 0;

  el.innerHTML = `<div class="files-page">
    <section class="block">
      <div class="block-h" style="gap:8px"><button class="btn" data-ref data-pop-anchor style="max-width:100%;min-width:0">${icon.branch(12)}<span class="ell mono" data-ref-label></span>${icon.chevronDown(11)}</button></div>
      <div style="padding:8px 10px;border-bottom:1px solid var(--line)"><label class="input">${icon.search(13)}<input data-filter placeholder="按路径筛选文件" autocomplete="off"><span class="count" data-fcount></span></label></div>
      <div class="tree" data-tree><div class="loading">加载中…</div></div>
    </section>
    <section class="block" data-right style="display:flex;flex-direction:column"></section>
  </div>`;
  const treeEl = el.querySelector('[data-tree]');
  const right = el.querySelector('[data-right]');

  function persist(push = false) {
    ctx.setParams({ ref, path: path || null, v: view === 'content' ? null : view, hc: view === 'history' ? hc : null }, { replace: !push });
  }

  /* ---------- 树 ---------- */
  async function loadTree() {
    const my = ++token;
    el.querySelector('[data-ref-label]').textContent = ref.length === 40 ? ref.slice(0, 10) : ref;
    treeEl.innerHTML = '<div class="loading">加载中…</div>';
    try {
      const d = await store.tree(ref);
      if (my !== token) return;
      tree = build(d.files);
      if (path) {
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) expanded.add(parts.slice(0, i).join('/'));
      }
      drawTree();
      if (!path) {
        const readme = d.files.find((f) => /^readme(\.md|\.txt)?$/i.test(f.p));
        showDir('', readme?.p);
      } else openPath(path, false);
    } catch (e) {
      if (my === token) treeEl.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }
  function build(files) {
    const root = { name: '', path: '', dirs: new Map(), files: [], count: 0 };
    const byPath = new Map();
    for (const f of files) {
      const parts = f.p.split('/');
      let node = root;
      node.count++;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts.slice(0, i + 1).join('/');
        if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { name: parts[i], path: p, dirs: new Map(), files: [], count: 0 });
        node = node.dirs.get(parts[i]);
        node.count++;
      }
      const leaf = { name: parts.at(-1), path: f.p, size: f.s, mode: f.m };
      node.files.push(leaf);
      byPath.set(f.p, leaf);
    }
    return { root, byPath, all: files };
  }
  function drawTree() {
    if (!tree) return;
    const fcount = el.querySelector('[data-fcount]');
    if (filter) {
      const q = filter.toLowerCase();
      const hits = tree.all.filter((f) => f.p.toLowerCase().includes(q));
      fcount.textContent = `${hits.length}`;
      treeEl.innerHTML = hits.slice(0, 500).map((f) => `<button class="node" data-file="${esc(f.p)}" aria-selected="${f.p === path}" title="${esc(f.p)}" style="padding-left:12px"><span class="file-ic">${icon.file(13)}</span><span class="ell">${esc(f.p)}</span></button>`).join('') + (hits.length > 500 ? `<div class="empty">还有 ${hits.length - 500} 个</div>` : '') || '<div class="empty">没有匹配的文件</div>';
      return;
    }
    fcount.textContent = `${num(tree.all.length)} 个文件`;
    const out = [];
    const walk = (node, depth) => {
      const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
      for (const d of dirs) {
        const open = expanded.has(d.path);
        out.push(`<button class="node" data-dir="${esc(d.path)}" aria-selected="${d.path === path}" style="padding-left:${8 + depth * 14}px"><span class="tw">${open ? icon.chevronDown(10) : icon.chevronRight(10)}</span><span class="dir-ic">${icon.folder(13)}</span><span class="ell">${esc(d.name)}</span><span class="faint" style="margin-left:auto;font-size:11px">${d.count}</span></button>`);
        if (open) walk(d, depth + 1);
      }
      for (const f of [...node.files].sort((a, b) => a.name.localeCompare(b.name))) {
        out.push(`<button class="node" data-file="${esc(f.path)}" aria-selected="${f.path === path}" style="padding-left:${8 + depth * 14 + 12}px"><span class="file-ic">${icon.file(13)}</span><span class="ell">${esc(f.name)}</span></button>`);
      }
    };
    walk(tree.root, 0);
    treeEl.innerHTML = out.join('');
  }

  /* ---------- 右侧 ---------- */
  function crumbs(p) {
    const parts = p ? p.split('/') : [];
    return `<div class="crumbs"><button data-dir="">${esc(M.raw.name)}</button>${parts.map((x, i) => `<span class="sep">/</span>${i === parts.length - 1 ? `<b>${esc(x)}</b>` : `<button data-dir="${esc(parts.slice(0, i + 1).join('/'))}">${esc(x)}</button>`}`).join('')}</div>`;
  }
  function findDir(p) {
    let node = tree.root;
    if (!p) return node;
    for (const part of p.split('/')) {
      node = node.dirs.get(part);
      if (!node) return null;
    }
    return node;
  }
  async function showDir(p, readme) {
    const node = findDir(p);
    if (!node) return;
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
    right.innerHTML = `<div class="block-h">${crumbs(p)}<span class="sub">${dirs.length} 个目录 · ${files.length} 个文件</span></div>
      <div style="overflow:auto;flex:1;min-height:0"><table class="tbl"><tbody>
        ${dirs.map((d) => `<tr class="click" data-dir="${esc(d.path)}"><td><div class="row"><span style="color:var(--s4)">${icon.folder(14)}</span>${esc(d.name)}</div></td><td class="num muted">${d.count} 个文件</td></tr>`).join('')}
        ${files.map((f) => `<tr class="click" data-file="${esc(f.path)}"><td><div class="row"><span class="muted">${icon.file(14)}</span>${esc(f.name)}${f.mode === 'link' ? ' <span class="pill quiet">链接</span>' : f.mode === 'sub' ? ' <span class="pill quiet">子模块</span>' : ''}</div></td><td class="num muted">${size(f.size)}</td></tr>`).join('')}
      </tbody></table>
      ${readme ? '<div data-readme style="border-top:1px solid var(--line)"></div>' : ''}</div>`;
    if (readme) {
      const my = token;
      const b = await store.blob(ref, readme).catch(() => null);
      if (my !== token || !b?.text) return;
      const box = right.querySelector('[data-readme]');
      if (box) box.innerHTML = `<div class="list-h">${icon.file(13)}${esc(readme)}</div><div class="diff-b">${await renderFileHtml(b.text, readme)}</div>`;
    }
  }

  function openPath(p, push = true) {
    if (!tree) return;
    if (tree.byPath.has(p)) {
      path = p;
      persist(push);
      drawTree();
      showFile();
    } else if (findDir(p)) {
      path = p;
      if (p) expanded.add(p);
      persist(push);
      drawTree();
      showDir(p);
    } else {
      right.innerHTML = `<div class="empty">在 ${esc(ref)} 里找不到 ${esc(p)}</div>`;
    }
  }

  function showFile() {
    const f = tree.byPath.get(path);
    right.innerHTML = `<div class="block-h" style="flex-wrap:wrap">${crumbs(path)}<span class="sub">${size(f.size)}</span>
        <div class="actions"><div class="seg"><button data-view="content">内容</button><button data-view="history">历史</button><button data-view="blame">逐行追溯</button></div></div></div>
      <div class="list-h" data-last style="font-weight:400;min-height:37px"></div>
      <div data-pane style="flex:1;min-height:0;display:flex;flex-direction:column"></div>`;
    right.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
    // 最后一次改动
    store.history(ref, path).then((h) => {
      const c = h.commits[0];
      const box = right.querySelector('[data-last]');
      if (!box || !c) return;
      const p = M.person(c.a);
      box.innerHTML = `${avatar(p ?? { name: c.an }, 18)}<b>${esc(p?.name ?? c.an)}</b><span class="ell t2" style="font-weight:400">${esc(c.s)}</span><span class="grow"></span><a class="sha-link" href="${ctx.href('graph', { c: c.h })}">${c.h.slice(0, 7)}</a><span class="muted">${ago(c.t)}</span><span class="muted">· 共 ${h.commits.length} 次修改</span>`;
    }).catch(() => {});
    drawPane();
  }
  function drawPane() {
    const pane = right.querySelector('[data-pane]');
    if (view === 'history') return drawHistory(pane);
    if (view === 'blame') return drawBlame(pane);
    return drawContent(pane);
  }

  async function drawContent(pane) {
    const my = token;
    pane.innerHTML = '<div class="loading">加载中…</div>';
    if (IMAGE_EXT.test(path)) {
      pane.innerHTML = `<div class="diff-b"><div class="img-one"><img src="${esc(store.rawUrl(ref, path))}" alt="${esc(path)}"></div></div>`;
      return;
    }
    try {
      const b = await store.blob(ref, path);
      if (my !== token) return;
      if (b.tooLarge) { pane.innerHTML = `<div class="empty">文件太大（${size(b.size)}），不在这里显示</div>`; return; }
      if (b.binary) { pane.innerHTML = `<div class="empty">二进制文件（${size(b.size)}）</div>`; return; }
      pane.innerHTML = `<div class="diff-b">${await renderFileHtml(b.text, path)}</div>`;
      const line = Number(ctx.params.get('l'));
      if (line) {
        const ln = pane.querySelector('#L' + line);
        ln?.classList.add('hl');
        ln?.scrollIntoView({ block: 'center' });
      }
    } catch (e) {
      if (my === token) pane.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  async function drawHistory(pane) {
    const my = token;
    pane.innerHTML = '<div class="loading">加载中…</div>';
    let h;
    try {
      h = await store.history(ref, path);
    } catch (e) {
      pane.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      return;
    }
    if (my !== token) return;
    if (!h.commits.length) { pane.innerHTML = '<div class="empty">没有历史</div>'; return; }
    if (!hc || !h.commits.some((c) => c.h === hc)) hc = h.commits[0].h;
    pane.innerHTML = `<div style="display:grid;grid-template-columns:360px minmax(0,1fr);flex:1;min-height:0">
      <div style="overflow:auto;border-right:1px solid var(--line)">${h.commits.map((c) => {
        const p = M.person(c.a);
        return `<div class="hist-item" data-hc="${c.h}" aria-selected="${c.h === hc}">${avatar(p ?? { name: c.an }, 20)}<div style="min-width:0"><div class="ell">${esc(c.s)}</div><div class="muted ell" style="font-size:11.5px">${esc(p?.name ?? c.an)} · ${when(c.t)}${c.old ? ` · 由 ${esc(c.old)} 改名` : c.p !== path ? ` · 当时叫 ${esc(c.p)}` : ''}</div></div>${lineStat(c.add, c.del)}</div>`;
      }).join('')}</div>
      <div data-hdiff style="min-width:0;display:flex;flex-direction:column"></div>
    </div>`;
    const showDiff = () => {
      const c = h.commits.find((x) => x.h === hc);
      pane.querySelectorAll('[data-hc]').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.hc === hc)));
      // 历史里最早的那次（且不是改名）就是文件被加进来的时候
      const created = !c.parent || (!c.old && c === h.commits.at(-1));
      const file = { p: c.p, old: c.old, st: c.old ? 'R' : created ? 'A' : 'M', add: c.add, del: c.del };
      mountDiff(pane.querySelector('[data-hdiff]'), {
        file,
        load: (o) => store.diff({ from: c.parent ?? 'EMPTY', to: c.h, path: c.p, old: c.old, ctx: o.ctx, ws: o.ws }),
        images: IMAGE_EXT.test(c.p) ? { before: c.parent && file.st !== 'A' ? store.rawUrl(c.parent, c.old ?? c.p) : null, after: store.rawUrl(c.h, c.p) } : null,
        extraActions: `<a class="btn sm ghost" href="${ctx.href('graph', { c: c.h })}">${icon.commit(12)}${c.h.slice(0, 7)}</a>`,
      });
    };
    pane.querySelector('[style*="overflow:auto"]').addEventListener('click', (e) => {
      const it = e.target.closest('[data-hc]');
      if (!it) return;
      hc = it.dataset.hc;
      persist();
      showDiff();
    });
    showDiff();
  }

  async function drawBlame(pane) {
    const my = token;
    pane.innerHTML = '<div class="loading">逐行追溯中…</div>';
    let b;
    try {
      [b] = await Promise.all([store.blame(ref, path), ensureLang(langOf(path))]);
    } catch (e) {
      pane.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      return;
    }
    if (my !== token) return;
    const lines = highlightLines(b.text.join('\n'), b.text.length > 20000 ? null : langOf(path));
    // 越新的改动颜色越深：按时间分 6 档
    const times = b.commits.map((c) => c.t);
    const lo = Math.min(...times);
    const hi = Math.max(...times);
    const tone = (t) => (hi === lo ? 5 : 1 + Math.round(((t - lo) / (hi - lo)) * 4));
    const SEQ = ['var(--seq0)', 'var(--seq2)', 'var(--seq3)', 'var(--seq4)', 'var(--seq5)', 'var(--seq6)'];
    const out = [];
    for (let i = 0; i < b.lines.length; i++) {
      const ci = b.lines[i];
      const c = b.commits[ci];
      const first = i === 0 || b.lines[i - 1] !== ci;
      const p = M.person(c.a);
      const gutter = first
        ? `<div class="bg" data-bh="${c.h}" data-tip="${esc(`${c.s}\n${p?.name ?? c.an} · ${stamp(c.t)} · ${c.h.slice(0, 7)}`)}">${avatar(p ?? { name: c.an }, 16)}<span class="s">${esc(c.s)}</span><span class="muted" style="font-size:11px;white-space:nowrap">${nowSec() - c.t < 365 * DAY ? ago(c.t) : new Date(c.t * 1000).getFullYear() + '年'}</span></div>`
        : '<div class="bg cont"></div>';
      out.push(`<div class="ln">${gutter}<span class="age" style="background:${SEQ[tone(c.t)]}"></span><span class="no">${i + 1}</span><span class="tx">${lines[i] || ' '}</span></div>`);
    }
    pane.innerHTML = `<div class="list-h" style="font-weight:400"><span class="muted">左边是每段代码最后一次被改动的提交；色条越深越新。</span><span class="grow"></span><span class="scale">旧${SEQ.slice(1).map((c) => `<i style="background:${c}"></i>`).join('')}新</span><span class="muted">${b.commits.length} 个提交涉及</span></div><div class="diff-b"><div class="code blame">${out.join('')}</div></div>`;
    pane.querySelector('.blame').addEventListener('click', (e) => {
      const g = e.target.closest('[data-bh]');
      if (g) location.hash = ctx.href('graph', { c: g.dataset.bh }).slice(1);
    });
  }

  /* ---------- 交互 ---------- */
  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-dir],[data-file],[data-view],[data-ref]');
    if (!t) return;
    if (t.dataset.ref !== undefined) {
      const items = [];
      for (const r of M.analyze().rows) items.push({ value: r.name, label: r.name, group: r.status === 'trunk' ? '主线' : '分支', hint: when(r.time) });
      for (const tg of M.tags) items.push({ value: tg.name, label: tg.name, group: '标签', hint: when(tg.date) });
      picker(t, { items, selected: [ref], placeholder: '切换分支或标签（只是查看）', width: 380, onPick: (v) => { ref = v; token++; persist(true); loadTree(); } });
    } else if (t.dataset.view) {
      view = t.dataset.view;
      persist();
      right.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
      token++;
      drawPane();
    } else if (t.dataset.file !== undefined) {
      token++;
      openPath(t.dataset.file);
    } else if (t.dataset.dir !== undefined) {
      const d = t.dataset.dir;
      if (t.closest('[data-tree]') && expanded.has(d) && path === d) expanded.delete(d);
      else if (d) expanded.add(d);
      token++;
      openPath(d);
    }
  });
  const fin = el.querySelector('[data-filter]');
  fin.addEventListener('input', debounce(() => { filter = fin.value.trim(); drawTree(); }, 120));

  loadTree();
  return {
    update(params) {
      const nref = params.get('ref') || ref;
      const npath = params.get('path') || '';
      const nview = params.get('v') || 'content';
      hc = params.get('hc') || hc;
      if (nref !== ref) { ref = nref; path = npath; view = nview; loadTree(); return; }
      if (npath !== path || nview !== view) { path = npath; view = nview; token++; openPath(path, false); }
    },
  };
}
