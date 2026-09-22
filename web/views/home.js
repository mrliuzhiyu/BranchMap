// 首页：只列出仓库，点进去再看。
import { esc, icon, ago } from '../lib/util.js';
import { listRepos } from '../lib/api.js';

export function mount(el, { href }) {
  el.innerHTML = `<div class="page"><div class="home">
    <h1>仓库</h1><div class="muted">选一个仓库查看它的提交图、分支、文件和成员动态。每个仓库单独一页。</div>
    <div class="repo-cards"><div class="loading">读取中…</div></div>
  </div></div>`;
  listRepos().then((list) => {
    const box = el.querySelector('.repo-cards');
    if (!box) return; // 已经离开首页
    list.sort((a, b) => (b.lastTime ?? 0) - (a.lastTime ?? 0));
    box.innerHTML = list.map((r) => `
      <a class="repo-card" href="${href(r.name, 'overview')}">
        <div class="row"><h3 class="ell">${esc(r.name)}</h3><span class="grow"></span>${r.dirty ? `<span class="pill warn" title="主工作区未提交的文件">${r.dirty} 个未提交</span>` : ''}</div>
        <div class="meta">
          ${r.head ? `<span class="pill accent">${icon.branch(12)}<span>${esc(r.head)}</span></span>` : '<span class="pill">游离 HEAD</span>'}
          <span class="pill quiet">${r.refs} 个引用</span>
          ${r.slug ? `<span class="pill quiet">${icon.cloud(12)}${esc(r.slug)}</span>` : ''}
        </div>
        <div class="last ell">${r.lastTime ? `${ago(r.lastTime)} · ${esc(r.lastAuthor)} · ${esc(r.lastSubject)}` : '还没有提交'}</div>
        <div class="faint mono ell" style="font-size:11px">${esc(r.path)}</div>
      </a>`).join('') || '<div class="empty">根目录下没有找到 Git 仓库</div>';
  }, (e) => {
    const box = el.querySelector('.repo-cards');
    if (box) box.innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
  });
  return {};
}
