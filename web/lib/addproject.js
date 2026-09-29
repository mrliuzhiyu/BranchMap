// 「添加项目」弹窗：粘贴仓库地址（GitHub 地址或本机路径），或者一键加上本机扫描目录里发现的仓库。
// 名称、分组可以不填（名称默认取仓库名）。加完直接进入这个项目，后台开始建云端副本。
import { esc, icon, toast } from './util.js';
import { request } from './api.js';

export async function openAddProject({ groups = [], onAdded }) {
  document.querySelector('.modal-wrap')?.remove();
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal" role="dialog" aria-label="添加项目">
    <div class="mh"><h3>添加项目</h3><button class="icon-btn" data-x data-tip="关闭 (Esc)">${icon.close(15)}</button></div>
    <label class="field big">${icon.branch(15)}<input data-remote placeholder="https://github.com/组织/仓库" autocomplete="off" spellcheck="false"></label>
    <div class="frow">
      <label class="field"><input data-name placeholder="名称（默认取仓库名）" maxlength="40"></label>
      <label class="field"><input data-group placeholder="分组" maxlength="20" list="bm-groups"></label>
      <datalist id="bm-groups">${groups.map((g) => `<option value="${esc(g)}">`).join('')}</datalist>
    </div>
    <div class="disc" data-disc><div class="quiet"><span class="spin" style="display:inline-grid">${icon.sync(12)}</span></div></div>
    <div class="mf"><span class="grow"></span><button class="btn ghost" data-x>取消</button><button class="btn primary" data-add>${icon.check(13)}添加</button></div>
  </div>`;
  document.body.append(wrap);
  const $ = (s) => wrap.querySelector(s);
  const remote = $('[data-remote]');
  setTimeout(() => remote.focus(), 0);
  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);

  // 本机发现、还没加进来的仓库
  request('/api/discovered').then((list) => {
    $('[data-disc]').innerHTML = list.length
      ? `<p class="dl" data-tip="扫描目录里找到、还没加成项目的仓库">${icon.desktop(12)} ${list.length}</p>${list.map((d, i) => `<button class="drow" data-pick="${i}" data-tip="${esc(d.path ?? '')}">${icon.folder(13)}<span class="dn">${esc(d.name)}</span><span class="dr">${esc(d.remote ?? '')}</span>${icon.arrowRight(12)}</button>`).join('')}`
      : '';
    $('[data-disc]').onclick = (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      const d = list[Number(b.dataset.pick)];
      remote.value = d.remote;
      $('[data-name]').value ||= d.name;
      remote.focus();
    };
  }).catch(() => {
    $('[data-disc]').innerHTML = '';
  });

  const add = async () => {
    const r = remote.value.trim();
    if (!r) {
      remote.focus();
      return;
    }
    const btn = $('[data-add]');
    btn.disabled = true;
    try {
      const res = await request('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ remote: r, name: $('[data-name]').value, group: $('[data-group]').value }) });
      close();
      onAdded?.(res.id);
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
    }
  };
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-x]')) close();
    else if (e.target.closest('[data-add]')) add();
  });
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input')) add();
  });
}
