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

  const tests = new Map(); // 环境下标 -> 测试结果（或 'running'）
  const drawEnvs = () => {
    $('[data-envs]').innerHTML = envs.map((e, i) => `<div class="ewrap"><div class="erow" data-i="${i}">
      <label class="field">${icon.server(13)}<input data-f="name" value="${esc(e.name)}" placeholder="生产" maxlength="20"></label>
      <select class="sselect" data-f="branch" data-tip="从哪条分支部署">${names.map((n) => `<option value="${esc(n)}" ${n === e.branch ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
      <label class="field"><input data-f="probe" value="${esc(e.probe ?? '')}" placeholder="https://…/health（可选）" spellcheck="false"></label>
      <button class="icon-btn" data-test data-tip="测试探测地址：发一次只读请求，看能不能读出线上跑的提交">${tests.get(i) === 'running' ? `<span class="spin" style="display:inline-grid">${icon.sync(13)}</span>` : icon.pulse(13)}</button>
      <button class="icon-btn" data-del data-tip="删除这个环境">${icon.close(13)}</button>
    </div>${testHtml(tests.get(i))}</div>`).join('') || '<div class="quiet">还没有环境</div>';
  };

  /** 测试结果：状态一行（读到的提交或读不出的原因）+ 接口返回的内容；读不出时说明服务该返回什么 */
  function testHtml(r) {
    if (!r || r === 'running') return '';
    if (r.failed) return `<div class="etest bad">${icon.xCircle(13)}<span>${esc(r.failed)}</span></div>`;
    const ok = r.state === 'up' && r.commit;
    const head = r.state !== 'up'
      ? `${icon.xCircle(13)}<span>连不上：${esc(r.error ?? r.detail ?? '')}</span>`
      : ok
        ? `${icon.checkCircle(13)}<span>读到提交 <b class="mono">${esc(r.short)}</b>${r.subject ? ` ${esc(r.subject)}` : ''}${r.version ? `（版本 ${esc(r.version)}）` : ''}${r.inRepo === false ? '，但云端副本里还没有这个提交' : ''}</span>`
        : `${icon.alert(13)}<span>在线，但读不出提交：${esc(r.detail ?? '接口没有返回提交号')}</span>`;
    let sample = r.sample ?? '';
    try {
      sample = JSON.stringify(JSON.parse(sample), null, 2);
    } catch { /* 不是 JSON，原样显示 */ }
    if (sample.length > 1200) sample = sample.slice(0, 1200) + ' …';
    return `<div class="etest ${ok ? 'ok' : r.state === 'up' ? 'warn' : 'bad'}">
      <div class="et1">${head}<span class="grow"></span><span class="muted">${r.http ? `HTTP ${r.http}` : ''}${r.latency != null ? ` · ${r.latency} ms` : ''}</span></div>
      ${!ok && r.state === 'up' ? `<p class="muted">要读出线上跑的版本，服务的这个接口需要返回提交号，比如 <code>{"commit": "&lt;git sha&gt;"}</code>（commit、sha、gitSha、revision 这些字段名都认）。BranchMap 只读这个接口，不会改服务。</p>` : ''}
      ${sample ? `<pre class="etj">${esc(sample)}</pre>` : ''}
    </div>`;
  }
  async function runTest(i) {
    const url = envs[i]?.probe?.trim();
    if (!url) return toast('先填探测地址');
    tests.set(i, 'running');
    drawEnvs();
    try {
      tests.set(i, await request(`/api/p/${encodeURIComponent(id)}/probe-test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) }));
    } catch (err) {
      tests.set(i, { failed: err.message });
    }
    if (wrap.isConnected) drawEnvs();
  }
  drawEnvs();
  // 打开设置就把填了地址的环境都测一遍：哪个读不出、为什么，一眼看到
  envs.forEach((e, i) => e.probe && runTest(i));
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
      tests.clear();
      drawEnvs();
      return;
    }
    const test = e.target.closest('[data-test]');
    if (test) {
      sync();
      runTest(Number(test.closest('.erow').dataset.i));
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
