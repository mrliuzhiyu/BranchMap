// 本机页：这台电脑上这个项目的所有工作区和本地分支，跟云端比——推送了没有、拉取了没有、有没有没提交的改动。
// 比较用的是 BranchMap 自己的云端副本，不会在你的仓库里执行 fetch；本机仓库只读。
import { esc, icon, ago, when, fullStamp } from '../lib/util.js';
import { openWorktreeChanges } from './graph.js';

export function mount(el, ctx) {
  const { store } = ctx;
  let showTemp = false;
  el.innerHTML = '<div class="page" data-scroll><div class="page-narrow" data-root></div></div>';
  const scroller = el.querySelector('[data-scroll]');
  const root = el.querySelector('[data-root]');

  function stateChips(c) {
    const out = [];
    if (c.missing) return '<span class="pill quiet">目录不在了</span>';
    const cl = c.cloud;
    if (cl?.unpushed > 0) out.push(`<span class="pill warn" data-tip="本机有、云端任何分支都没有的提交">${icon.arrowUp(11)}<span>${cl.unpushed} 个没推送</span></span>`);
    if (cl && !cl.cloudExists && c.branch) {
      out.push(cl.unpushed > 0
        ? `<span class="pill warn" data-tip="云端没有对应的分支，这些提交只在本机">${icon.cloud(11)}<span>云端没有这条分支</span></span>`
        : `<span class="pill quiet" data-tip="云端已经没有同名分支（多半合并后删了），但这条分支的提交云端都有">${icon.cloud(11)}<span>云端分支已删 · 提交都在</span></span>`);
    }
    if (cl?.behind > 0) out.push(`<span class="pill" data-tip="云端 ${esc(cl.cloudName ?? '')} 有、本机没有的提交">${icon.arrowDown(11)}<span>落后云端 ${cl.behind}</span></span>`);
    if (c.conflicts) out.push(`<span class="pill bad">${icon.xCircle(11)}<span>${c.conflicts} 个冲突</span></span>`);
    if (c.total) out.push(`<span class="pill accent" data-tip="${esc(`已暂存 ${c.staged ?? 0} · 未暂存 ${c.unstaged ?? 0} · 新文件 ${c.untracked ?? 0}`)}">${icon.pencil(11)}<span>${c.total} 个文件有改动</span></span>`);
    if (!c.branch && c.head) out.push(`<span class="pill quiet" data-tip="没有检出分支，停在某个提交上">游离 ${c.head.slice(0, 7)}${c.inCloud === false ? '（云端没有）' : ''}</span>`);
    if (!out.length && cl) out.push(`<span class="pill good">${icon.check(11)}<span>和云端一致</span></span>`);
    return out.join('');
  }

  function render() {
    const o = ctx.overview;
    const L = o.local;
    if (!L || !L.checkouts.length) {
      root.innerHTML = `<div class="block"><div class="block-b">这台电脑的扫描目录（config.json 里的 scan）下面没有 ${esc(o.name)} 的仓库，所以这里没有东西。云端和环境的情况在「流水线」里照常能看。</div></div>`;
      return;
    }
    const c = L.counts;
    const visible = L.checkouts.filter((x) => showTemp || !x.temp);
    const temp = L.checkouts.filter((x) => x.temp).length;
    const repoName = (i) => L.repos[i]?.name ?? '';
    const rows = visible.map((x) => `<tr class="${x.total && !x.missing ? 'click' : ''}" data-co="${x.id}">
        <td style="max-width:320px"><div class="path-cell"><div class="row"><b class="ell">${esc(x.name)}</b>${x.main ? '<span class="pill quiet">主工作区</span>' : ''}${x.temp ? '<span class="pill quiet">临时</span>' : ''}</div><div class="p" title="${esc(x.path)}"><span>${esc(x.path)}</span></div></div></td>
        <td>${x.branch ? `<span class="mono" style="font-size:12px">${esc(x.branch)}</span>` : '<span class="muted">—</span>'}</td>
        <td><div class="state-chips">${stateChips(x)}</div></td>
        <td class="r">${x.total && !x.missing ? `<span class="btn sm ghost">${icon.eye(12)}看改动</span>` : ''}</td>
      </tr>`).join('');
    const branches = L.branches.filter((b) => b.unpushed > 0 || b.behind > 0 || (b.cloudName && b.cloudExists === false && b.unpushed));
    const brRows = branches.map((b) => `<tr>
        <td><span class="mono" style="font-size:12px">${esc(b.name)}</span>${L.repos.length > 1 ? ` <span class="faint" style="font-size:11px">${esc(repoName(b.repo))}</span>` : ''}</td>
        <td class="ell t2" style="max-width:360px" title="${esc(b.subject)}">${esc(b.subject)}</td>
        <td class="muted" data-tip="${fullStamp(b.time)}">${when(b.time)}</td>
        <td><div class="state-chips">${b.unpushed ? `<span class="pill warn">${icon.arrowUp(11)}<span>${b.unpushed} 个没推送</span></span>` : ''}${b.cloudExists === false ? `<span class="pill quiet">云端没有 ${esc(b.cloudName ?? b.name)}</span>` : ''}${b.behind ? `<span class="pill">${icon.arrowDown(11)}<span>落后云端 ${b.behind}</span></span>` : ''}</div></td>
        <td class="muted">${b.checkedOut.length ? `${icon.folder(12)} ${b.checkedOut.map((id) => esc(L.checkouts.find((x) => x.id === id)?.name ?? '')).join('、')}` : ''}</td>
      </tr>`).join('');
    const tile = (n, k, d, warn) => `<div class="tile"><div class="k">${k}</div><div class="v"${warn && n ? ' style="color:var(--warning-ink)"' : ''}>${n}</div><div class="d">${d}</div></div>`;
    root.innerHTML = `
      <div class="local-note">${icon.info(12)}${esc(o.name)} 在这台电脑上的 ${c.checkouts} 个工作区，和 BranchMap 的云端副本比（${o.sync.lastOk ? ago(Math.floor(o.sync.lastOk / 1000)) + '同步' : '还没同步'}），不会在你的仓库里 fetch · ${ago(Math.floor(L.scannedAt / 1000))}扫描</div>
      <div class="tiles" style="margin-bottom:16px">
        ${tile(c.unpushedBranches, `${icon.arrowUp(12)}没推送的分支`, c.unpushedCommits ? `共 ${c.unpushedCommits} 个提交只在本机` : '都推上去了', true)}
        ${tile(c.behind, `${icon.arrowDown(12)}落后云端的工作区`, '云端有新提交，本机还没拉', false)}
        ${tile(c.dirty, `${icon.pencil(12)}有改动的工作区`, '改了还没提交', false)}
        ${tile(L.stashes, `${icon.archive(12)}stash`, 'git stash 里存着的改动', false)}
      </div>
      <section class="block" style="margin-bottom:16px">
        <div class="block-h"><h2>${icon.folder(14)}工作区</h2><span class="sub">每个检出的目录现在在哪条分支、和云端差多少</span>
          ${temp ? `<div class="actions"><label class="check"><input type="checkbox" data-temp ${showTemp ? 'checked' : ''}>显示临时目录里的 ${temp} 个</label></div>` : ''}</div>
        <table class="tbl"><thead><tr><th>目录</th><th>分支</th><th>状态</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      </section>
      <section class="block">
        <div class="block-h"><h2>${icon.branch(14)}要处理的本地分支</h2><span class="sub">没推送、或者落后云端的</span></div>
        ${brRows ? `<table class="tbl"><thead><tr><th>分支</th><th>最后一个提交</th><th>时间</th><th>状态</th><th>检出在</th></tr></thead><tbody>${brRows}</tbody></table>` : `<div class="ok-box">${icon.checkCircle(16)}本地分支都和云端一致</div>`}
      </section>`;
  }

  root.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-co].click');
    if (!tr) return;
    const id = Number(tr.dataset.co);
    const list = await store.loadWorktrees(true).catch(() => null);
    const w = list?.find((x) => x.id === id);
    if (w) openWorktreeChanges(store, w, null);
  });
  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-temp]')) {
      showTemp = e.target.checked;
      render();
    }
  });

  render();
  return {
    refresh() {
      const top = scroller.scrollTop;
      render();
      scroller.scrollTop = top;
    },
  };
}

