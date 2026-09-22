// 提交详情：标题与说明、作者时间、父子提交、进 dev / main 的时间、首次发布的标签、所在分支、改了哪些文件。
import { esc, icon, avatar, stamp, ago, fullStamp, lineStat, filePath, copyText } from './util.js';
import { openChanges } from './changes.js';

export function commitChangesLoader(store, base, to) {
  return {
    load: (f, opts) => store.diff({ from: base ?? 'EMPTY', to, path: f.p, old: f.old, ctx: opts.ctx, ws: opts.ws }),
    images: (f) => ({
      before: f.st === 'A' || !base ? null : store.rawUrl(base, f.old ?? f.p),
      after: f.st === 'D' ? null : store.rawUrl(to, f.p),
    }),
  };
}

/** 画进 el；onNavigate(hash) 用于点父/子提交跳转。返回一个取消函数。 */
export function renderCommit(el, { store, model: M, c, onNavigate, href }) {
  const hash = M.h[c];
  let parent = 1;
  let alive = true;
  const person = M.person(M.a[c]);
  const children = [];
  for (let i = c - 1; i >= 0; i--) if (M.P[i].includes(c)) children.push(i);
  const prodT = M.prodT;
  const devT = M.devT;
  const inProd = M.enteredAt(c, prodT);
  const inDev = M.enteredAt(c, devT);
  const { branches, firstTag } = M.containedIn(c);
  const slug = M.raw.slug;
  const pr = M.prByMerge?.get(hash);

  const link = (i) => `<span class="sha-link" data-nav="${M.h[i]}" data-tip="${esc(M.s[i])}">${M.short(i)}</span>`;
  const entered = (info, name) => {
    if (!name) return '';
    if (!info) return `<dt>${esc(name)}</dt><dd><span class="pill quiet">还没进 ${esc(name)}</span></dd>`;
    return `<dt>${esc(name)}</dt><dd>${info.direct ? '直接提交在' : '合入'} ${esc(name)} · <span data-tip="${fullStamp(info.time)}">${stamp(info.time)}</span>${info.direct ? '' : ` · 经由 ${link(info.commit)}`}</dd>`;
  };
  const BR_LIMIT = 14;
  const brs = branches.sort((x, y) => (y === M.prodB) - (x === M.prodB) || (y === M.devB) - (x === M.devB) || M.ct[y.tip] - M.ct[x.tip]);
  const subject = M.s[c];

  el.innerHTML = `
    <div class="dsec">
      <p class="dsubject">${esc(subject)}</p>
      <pre class="dbody" data-body hidden></pre>
    </div>
    <div class="dsec">
      <dl class="kv">
        <dt>作者</dt><dd>${avatar(person, 20)}<b>${esc(person?.name ?? '?')}</b><span class="muted" data-email></span></dd>
        <dt>时间</dt><dd><span data-tip="${fullStamp(M.t[c])}">${stamp(M.t[c])}</span><span class="muted">${ago(M.t[c])}</span></dd>
        <dd data-committer hidden style="grid-column:1/-1"></dd>
        <dt>提交</dt><dd><span class="mono">${hash.slice(0, 12)}</span><button class="copy" data-copy="${hash}" data-tip="复制完整哈希">${icon.copy(13)}</button>${slug ? `<a class="copy" href="https://github.com/${esc(slug)}/commit/${hash}" target="_blank" rel="noreferrer" data-tip="在 GitHub 打开">${icon.ext(13)}</a>` : ''}</dd>
        <dt>父提交</dt><dd>${M.P[c].length ? M.P[c].map(link).join(' ') : '<span class="muted">无（第一个提交）</span>'}${M.P[c].length > 1 ? '<span class="pill quiet">合并提交</span>' : ''}</dd>
        ${children.length ? `<dt>子提交</dt><dd>${children.slice(0, 6).map(link).join(' ')}${children.length > 6 ? `<span class="muted">等 ${children.length} 个</span>` : ''}</dd>` : ''}
        ${pr ? `<dt>PR</dt><dd><a href="${esc(pr.url)}" target="_blank" rel="noreferrer" class="row"><span class="pr ${pr.state}">#${pr.n}</span><span class="ell">${esc(pr.title)}</span></a></dd>` : ''}
      </dl>
    </div>
    <div class="dsec">
      <h4>位置</h4>
      <dl class="kv">
        ${entered(inDev, M.trunk.dev)}
        ${entered(inProd, M.trunk.prod)}
        <dt>首次发布</dt><dd>${firstTag ? `<span class="pill">${icon.tag(11)}<span>${esc(firstTag.name)}</span></span><span class="muted">${stamp(firstTag.date)}</span>` : '<span class="muted">还没有标签包含它</span>'}</dd>
        <dt>所在分支</dt><dd>${brs.length ? brs.slice(0, BR_LIMIT).map((B) => `<a class="pill" href="${href('branches', { tab: 'compare', cmp: `${M.baseB && M.baseB !== B ? M.baseB.name : ''}...${B.name}` })}">${icon.branch(11)}<span>${esc(B.name)}</span></a>`).join('') + (brs.length > BR_LIMIT ? `<span class="muted">等 ${brs.length} 条</span>` : '') : '<span class="muted">没有分支指向它的后代（游离提交）</span>'}</dd>
      </dl>
    </div>
    <div class="dsec" style="padding-bottom:6px">
      <h4><span data-files-title>文件</span><span class="grow"></span><span data-parent-seg></span><button class="btn sm" data-open-all hidden>查看全部差异</button></h4>
      <div class="files" data-files style="margin:0 -16px"><div class="loading" style="padding:16px">加载中…</div></div>
    </div>`;

  const load = async () => {
    const d = await store.commit(hash, parent);
    if (!alive) return;
    const body = d.message.split('\n').slice(1).join('\n').trim();
    const bodyEl = el.querySelector('[data-body]');
    if (body) { bodyEl.textContent = body; bodyEl.hidden = false; }
    el.querySelector('[data-email]').textContent = d.author.email;
    if (d.committer.name !== d.author.name || Math.abs(d.committer.time - d.author.time) > 120) {
      const cm = el.querySelector('[data-committer]');
      cm.hidden = false;
      cm.innerHTML = `<dl class="kv" style="width:100%"><dt>提交者</dt><dd>${esc(d.committer.name)}<span class="muted">${stamp(d.committer.time)}</span></dd></dl>`;
    }
    if (M.P[c].length > 1) {
      el.querySelector('[data-parent-seg]').innerHTML = `<div class="seg">${M.P[c].map((q, i) => `<button data-parent="${i + 1}" aria-pressed="${parent === i + 1}" data-tip="${i === 0 ? '和第一父比：这次合并带进来的全部改动' : '和第 ' + (i + 1) + ' 父比'}">对比父 ${i + 1}</button>`).join('')}</div>`;
    }
    const add = d.files.reduce((s, f) => s + f.add, 0);
    const del = d.files.reduce((s, f) => s + f.del, 0);
    el.querySelector('[data-files-title]').innerHTML = `文件 ${d.files.length} ${lineStat(add, del)}`;
    const openAll = el.querySelector('[data-open-all]');
    openAll.hidden = !d.files.length;
    const files = el.querySelector('[data-files]');
    files.innerHTML = d.files.map((f, i) => `<button class="f" data-f="${i}" title="${esc(f.old && f.old !== f.p ? f.old + ' → ' + f.p : f.p)}"><span class="st ${f.st}">${f.st}</span>${filePath(f.p)}${f.bin ? '<span class="faint" style="font-size:11px">二进制</span>' : lineStat(f.add, f.del)}</button>`).join('') || '<div class="empty" style="padding:12px">没有文件改动</div>';
    const open = (path) => {
      const loader = commitChangesLoader(store, d.base, d.h);
      openChanges({ title: subject, sub: `${M.short(c)} · ${esc(person?.name ?? '')} · ${stamp(M.t[c])}${M.P[c].length > 1 ? ` · 对比父 ${parent}` : ''}`, files: d.files, select: path, ...loader });
    };
    files.onclick = (e) => {
      const b = e.target.closest('[data-f]');
      if (b) open(d.files[Number(b.dataset.f)].p);
    };
    openAll.onclick = () => open(null);
  };
  const fail = (e) => {
    if (alive) el.querySelector('[data-files]').innerHTML = `<div class="empty" style="padding:12px">${esc(e.message)}</div>`;
  };
  load().catch(fail);

  el.onclick = (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) return onNavigate(nav.dataset.nav);
    const cp = e.target.closest('[data-copy]');
    if (cp) return copyText(cp.dataset.copy);
    const pb = e.target.closest('[data-parent]');
    if (pb) {
      parent = Number(pb.dataset.parent);
      el.querySelectorAll('[data-parent]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.parent) === parent)));
      el.querySelector('[data-files]').innerHTML = '<div class="loading" style="padding:16px">加载中…</div>';
      load().catch(fail);
    }
  };
  return () => { alive = false; };
}
