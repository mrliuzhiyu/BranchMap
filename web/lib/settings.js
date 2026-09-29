// 「项目设置」弹窗：
//   主线 —— 上线分支（生产代码所在的分支，如 main）+ 集成分支（日常合并、部署到测试的分支，如 dev，可以不要）
//   环境 —— 服务器 / 发布渠道：名称、从哪条分支部署、探测地址（可选；填了就读出线上实际跑的提交）
// 分支是代码，环境是跑代码的地方：环境标签挂在它实际运行的那个提交上。
import { esc, icon, toast } from './util.js';
import { request } from './api.js';

const LIKELY = ['main', 'master', 'production', 'prod', 'release', 'dev', 'develop', 'development', 'staging', 'test'];

export function openSettings({ id, name, model }) {
  document.querySelector('.modal-wrap')?.remove();
  const M = model;
  const names = [...M.branches.keys()].sort((a, b) => {
    const ia = LIKELY.indexOf(a);
    const ib = LIKELY.indexOf(b);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return a.localeCompare(b);
  });
  const opts = (sel, withNone) => (withNone ? `<option value="" ${!sel ? 'selected' : ''}>无</option>` : '') + names.map((n) => `<option value="${esc(n)}" ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('');
  const envs = (M.raw.envs ?? []).map((e) => ({ id: e.id, name: e.name, branch: e.branch, probe: e.probe }));

  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal settings" role="dialog" aria-label="项目设置">
    <div class="mh"><h3>${icon.repo(15)} ${esc(name)}</h3><button class="icon-btn" data-x data-tip="关闭 (Esc)">${icon.close(15)}</button></div>
    <section>
      <p class="sl">${icon.branch(12)}主线<span class="sh" data-tip="主线是代码的流向：日常先合进集成分支（部署到测试），测过再合进上线分支（部署到生产）。提交图上这两条画成贯穿全图的粗线。">?</span></p>
      <div class="srow"><span class="slab"><i class="rbar" style="--c:var(--s1)"></i>上线分支</span><select class="sselect" data-prod>${opts(M.trunk.prod, false)}</select></div>
      <div class="srow"><span class="slab"><i class="rbar" style="--c:var(--s2)"></i>集成分支</span><select class="sselect" data-dev>${opts(M.trunk.dev, true)}</select></div>
    </section>
    <section>
      <p class="sl">${icon.server(12)}环境<span class="sh" data-tip="环境是跑代码的地方（测试服务器、生产服务器、发布渠道）。填了探测地址，就能读出线上实际运行的是哪个提交；不填，就先挂在它的分支最新提交上。">?</span></p>
      <div class="envs" data-envs></div>
      <button class="more" data-add-env>${icon.plus(12)}<span>添加环境</span></button>
    </section>
    <div class="mf"><span class="grow"></span><button class="btn ghost" data-x>取消</button><button class="btn primary" data-save>${icon.check(13)}保存</button></div>
  </div>`;
  document.body.append(wrap);
  const $ = (s) => wrap.querySelector(s);

  const drawEnvs = () => {
    $('[data-envs]').innerHTML = envs.map((e, i) => `<div class="erow" data-i="${i}">
      <label class="field">${icon.server(13)}<input data-f="name" value="${esc(e.name)}" placeholder="生产" maxlength="20"></label>
      <select class="sselect" data-f="branch" data-tip="从哪条分支部署">${names.map((n) => `<option value="${esc(n)}" ${n === e.branch ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
      <label class="field"><input data-f="probe" value="${esc(e.probe ?? '')}" placeholder="https://…/health（可选）" spellcheck="false"></label>
      <button class="icon-btn" data-del data-tip="删除这个环境">${icon.close(13)}</button>
    </div>`).join('') || '<div class="quiet">还没有环境</div>';
  };
  drawEnvs();
  const sync = () => {
    wrap.querySelectorAll('.erow').forEach((row) => {
      const e = envs[Number(row.dataset.i)];
      row.querySelectorAll('[data-f]').forEach((f) => (e[f.dataset.f] = f.value));
    });
  };

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

  wrap.addEventListener('click', async (e) => {
    if (e.target === wrap || e.target.closest('[data-x]')) return close();
    if (e.target.closest('[data-add-env]')) {
      sync();
      const used = new Set(envs.map((x) => x.name));
      const guess = !used.has('测试') && M.trunk.dev ? { name: '测试', branch: M.trunk.dev } : !used.has('生产') ? { name: '生产', branch: M.trunk.prod } : { name: '', branch: M.trunk.prod };
      envs.push({ ...guess, probe: '' });
      drawEnvs();
      wrap.querySelector('.erow:last-child [data-f="name"]')?.focus();
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      sync();
      envs.splice(Number(del.closest('.erow').dataset.i), 1);
      drawEnvs();
      return;
    }
    if (e.target.closest('[data-save]')) {
      sync();
      const prod = $('[data-prod]').value;
      const dev = $('[data-dev]').value;
      if (dev && dev === prod) return toast('上线分支和集成分支不能是同一条');
      const list = envs.filter((x) => x.name.trim()).map((x) => ({ id: x.id, name: x.name.trim(), branch: x.branch, probe: x.probe?.trim() || null }));
      const btn = $('[data-save]');
      btn.disabled = true;
      try {
        await request(`/api/p/${encodeURIComponent(id)}/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flow: dev ? [dev, prod] : [prod], environments: list }) });
        close();
        toast('已保存');
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    }
  });
}
