// 「添加项目」弹窗：
//   - 连了 GitHub（GitHub App）：列出授权给 BranchMap 的仓库，勾选后一次加上；「管理授权」去 GitHub 增减仓库
//   - 没连：管理员点「连接 GitHub」，在 GitHub 上创建应用、选组织和仓库，回来就能勾选
//   - 也可以粘贴仓库地址（GitHub 地址或本机路径），或者一键加上本机扫描目录里发现的仓库
// 名称、分组可以不填（名称默认取仓库名）。加完进入第一个项目，后台开始建云端副本。
import { esc, icon, toast } from './util.js';
import { request } from './api.js';

export async function openAddProject({ groups = [], onAdded }) {
  document.querySelector('.modal-wrap')?.remove();
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal" role="dialog" aria-label="添加项目">
    <div class="mh"><h3>添加项目</h3><button class="icon-btn" data-x data-tip="关闭 (Esc)">${icon.close(15)}</button></div>
    <div class="ghsec" data-gh><div class="quiet"><span class="spin" style="display:inline-grid">${icon.sync(12)}</span></div></div>
    <label class="field big">${icon.branch(15)}<input data-remote placeholder="或者粘贴仓库地址：https://github.com/组织/仓库" autocomplete="off" spellcheck="false"></label>
    <div class="frow">
      <label class="field"><input data-name placeholder="名称（默认取仓库名）" maxlength="40"></label>
      <label class="field"><input data-group placeholder="分组" maxlength="20" list="bm-groups"></label>
      <datalist id="bm-groups">${groups.map((g) => `<option value="${esc(g)}">`).join('')}</datalist>
    </div>
    <div class="disc" data-disc></div>
    <div class="mf"><span class="grow"></span><button class="btn ghost" data-x>取消</button><button class="btn primary" data-add>${icon.check(13)}<span data-addl>添加</span></button></div>
  </div>`;
  document.body.append(wrap);
  const $ = (s) => wrap.querySelector(s);
  const remote = $('[data-remote]');
  const picked = new Set(); // 勾选的 GitHub 仓库（owner/repo）
  let gh = null;
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
  const label = () => {
    $('[data-addl]').textContent = picked.size > 1 ? `添加 ${picked.size} 个` : '添加';
  };

  /* ---------- GitHub ---------- */
  let q = '';
  function drawGitHub() {
    const box = $('[data-gh]');
    if (!gh) return void (box.innerHTML = '');
    if (!gh.connected) {
      box.innerHTML = gh.admin
        ? `<div class="ghcon">
            <div class="ght">${icon.github(18)}<div><b>连接 GitHub</b><span>在 GitHub 上授权 BranchMap 只读访问仓库，之后在这里勾选就能添加</span></div></div>
            <div class="ghgo"><label class="field"><input data-org placeholder="组织名（建议填，比如公司的 GitHub 组织）" autocomplete="off" spellcheck="false"></label><button class="btn primary" data-connect>${icon.github(13)}连接</button></div>
          </div>`
        : `<div class="ghcon"><div class="ght">${icon.github(18)}<div><b>还没有连接 GitHub</b><span>请管理员在这里连接</span></div></div></div>`;
      return;
    }
    const list = gh.repos ?? [];
    const shown = q ? list.filter((r) => (r.slug + ' ' + r.description).toLowerCase().includes(q)) : list;
    box.innerHTML = `<p class="dl">
        ${icon.github(12)}<span data-tip="${esc(`${gh.app.name}\n装在：${gh.installations.map((i) => i.account).join('、') || '还没装到任何组织'}`)}">${gh.installations.map((i) => esc(i.account)).join(' · ') || '还没安装'}</span>
        <span class="grow"></span>
        ${gh.admin ? `<a href="${esc(gh.installUrl)}" data-tip="去 GitHub 选组织、增减授权的仓库">${icon.gear(12)}管理授权</a>` : ''}
      </p>
      ${gh.error ? `<div class="quiet">${icon.alert(12)} ${esc(gh.error)}</div>` : ''}
      ${list.length > 8 ? `<label class="field ghq">${icon.search(13)}<input data-q placeholder="搜索仓库" value="${esc(q)}" autocomplete="off" spellcheck="false"></label>` : ''}
      <div class="ghlist">${shown.map((r) => `<button class="drow${r.added ? ' added' : picked.has(r.slug) ? ' on' : ''}" data-repo="${esc(r.slug)}" ${r.added ? 'disabled' : ''} data-tip="${esc(r.added ? '已经是项目了' : r.description || r.slug)}">
          <span class="ck">${r.added || picked.has(r.slug) ? icon.check(11) : ''}</span>
          <span class="dn">${esc(r.slug.split('/')[1])}</span><span class="dr">${esc(r.slug.split('/')[0])}${r.private ? ' · 私有' : ''}</span>
        </button>`).join('') || `<div class="quiet">${list.length ? '没有匹配的仓库' : '还没有授权任何仓库：点「管理授权」去勾选'}</div>`}</div>`;
  }
  request('/api/github').then((s) => {
    gh = s;
    drawGitHub();
  }).catch(() => {
    $('[data-gh]').innerHTML = '';
  });
  $('[data-gh]').addEventListener('click', (e) => {
    if (e.target.closest('[data-connect]')) {
      const org = $('[data-org]').value.trim();
      location.href = '/github/connect' + (org ? '?org=' + encodeURIComponent(org) : '');
      return;
    }
    const b = e.target.closest('[data-repo]');
    if (!b || b.disabled) return;
    const s = b.dataset.repo;
    picked.has(s) ? picked.delete(s) : picked.add(s);
    drawGitHub();
    label();
  });
  $('[data-gh]').addEventListener('input', (e) => {
    if (!e.target.matches('[data-q]')) return;
    q = e.target.value.trim().toLowerCase();
    const pos = e.target.selectionStart;
    drawGitHub();
    const inp = $('[data-q]');
    inp.focus();
    inp.setSelectionRange(pos, pos);
  });

  /* ---------- 本机发现、还没加进来的仓库 ---------- */
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

  /* ---------- 添加 ---------- */
  const post = (body) => request('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const add = async () => {
    const r = remote.value.trim();
    const repos = [...picked];
    if (!r && !repos.length) {
      remote.focus();
      return;
    }
    const btn = $('[data-add]');
    btn.disabled = true;
    const group = $('[data-group]').value;
    let first = null;
    let done = 0;
    try {
      // 勾选的仓库：名称默认取仓库名；填了名称只用在手填地址那一个上
      for (const slug of repos) {
        const res = await post({ remote: `https://github.com/${slug}.git`, name: repos.length === 1 && !r ? $('[data-name]').value : '', group });
        first ??= res.id;
        done++;
      }
      if (r) {
        const res = await post({ remote: r, name: $('[data-name]').value, group });
        first ??= res.id;
        done++;
      }
      close();
      onAdded?.(first);
    } catch (e) {
      toast(done ? `加了 ${done} 个，后面的没加上：${e.message}` : e.message);
      btn.disabled = false;
    }
  };
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-x]')) close();
    else if (e.target.closest('[data-add]')) add();
  });
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-remote], [data-name], [data-group]')) add();
    if (e.key === 'Enter' && e.target.matches('[data-org]')) $('[data-connect]')?.click();
  });
}
