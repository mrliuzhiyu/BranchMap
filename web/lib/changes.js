// 「改动」抽屉：左边文件列表，右边差异。提交详情、分支对比、未提交的改动都用它。
import { esc, icon, filePath, lineStat, IMAGE_EXT } from './util.js';
import { mountDiff } from './code.js';
import { resizer } from './resize.js';

let current = null;
export function closeChanges() {
  if (!current) return;
  current.el.remove();
  document.removeEventListener('keydown', current.onKey, true);
  current.onClose?.();
  current = null;
}

/**
 * files: [{ p, old, st, add, del, bin }]
 * load(file, { ctx, ws }) → Promise<{ patch, binary, tooLarge }>
 * images(file) → { before, after } | null
 */
export function openChanges({ title, sub = '', files, load, images = null, select = null, onClose = null, groups = null }) {
  closeChanges();
  const el = document.createElement('div');
  el.className = 'overlay';
  const totalAdd = files.reduce((s, f) => s + (f.add ?? 0), 0);
  const totalDel = files.reduce((s, f) => s + (f.del ?? 0), 0);
  el.innerHTML = `<section class="drawer" role="dialog" aria-label="${esc(title)}">
    <div class="drawer-h">
      <div class="grow" style="min-width:0"><h3 class="ell">${esc(title)}</h3><div class="muted ell" style="font-size:12px;margin-top:2px">${sub}</div></div>
      <span class="muted" style="font-size:12px">${files.length} 个文件</span>${lineStat(totalAdd, totalDel)}
      <button class="icon-btn" data-close title="关闭 (Esc)">${icon.close(16)}</button>
    </div>
    <div class="drawer-b"><div class="side files"></div><div class="main"></div><div class="rz-files"></div></div>
    <div class="rz-drawer"></div>
  </section>`;
  document.body.append(el);
  // 抽屉整体宽度（拖左边）和文件列表宽度（拖中间的分界）都能拖，记在浏览器里
  const drawer = el.querySelector('.drawer');
  resizer(el.querySelector('.rz-drawer'), { target: drawer, prop: '--drw', key: 'drawer', min: 560, max: () => innerWidth - 40, dir: -1, def: Math.min(1100, innerWidth * 0.92) });
  resizer(el.querySelector('.rz-files'), { target: drawer, prop: '--dfw', key: 'drawer-files', min: 180, max: 640, dir: 1, def: 320 });
  const side = el.querySelector('.side');
  const main = el.querySelector('.main');
  let idx = Math.max(0, files.findIndex((f) => f.p === select));

  const drawList = () => {
    let html = '';
    let lastGroup = null;
    files.forEach((f, i) => {
      const g = groups?.(f);
      if (g && g !== lastGroup) {
        html += `<div class="fgrp">${esc(g)}</div>`;
        lastGroup = g;
      }
      html += `<button class="f" data-i="${i}" aria-selected="${i === idx}" title="${esc(f.old && f.old !== f.p ? f.old + ' → ' + f.p : f.p)}"><span class="st ${esc(f.st)}">${esc(f.st)}</span>${filePath(f.p)}${f.bin ? '<span class="faint" style="font-size:11px">二进制</span>' : lineStat(f.add, f.del)}</button>`;
    });
    side.innerHTML = html || '<div class="empty">没有文件改动</div>';
  };
  const show = (i) => {
    if (!files.length) {
      main.innerHTML = '<div class="empty">没有文件改动</div>';
      return;
    }
    idx = (i + files.length) % files.length;
    drawList();
    side.querySelector(`[data-i="${idx}"]`)?.scrollIntoView({ block: 'nearest' });
    const f = files[idx];
    mountDiff(main, {
      file: f,
      load: (opts) => load(f, opts),
      images: IMAGE_EXT.test(f.p) && images ? images(f) : null,
      nav: files.length > 1 ? { prev: () => show(idx - 1), next: () => show(idx + 1) } : null,
    });
  };
  side.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (b) show(Number(b.dataset.i));
  });
  el.addEventListener('mousedown', (e) => {
    if (e.target === el) closeChanges();
  });
  el.querySelector('[data-close]').addEventListener('click', closeChanges);
  const onKey = (e) => {
    if (e.target.closest?.('input, textarea, select')) return;
    if (e.key === 'Escape') { closeChanges(); e.stopPropagation(); }
    else if (e.key === 'j' || e.key === 'ArrowDown') { show(idx + 1); e.preventDefault(); e.stopPropagation(); }
    else if (e.key === 'k' || e.key === 'ArrowUp') { show(idx - 1); e.preventDefault(); e.stopPropagation(); }
  };
  document.addEventListener('keydown', onKey, true);
  current = { el, onKey, onClose };
  show(idx);
}
