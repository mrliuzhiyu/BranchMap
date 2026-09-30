// 自由拖动改宽度：面板的边、表格列的边都用它。
// 拖动时实时改一个 CSS 变量（布局里用 var(--x, 默认值)），松手记在浏览器里，下次打开还是这个宽度；双击边恢复默认。
//
//   resizer(handle, { target, prop: '--lw', key: 'graph-left', min: 180, max: 480, dir: 1, def: 264, onChange })
//   dir =  1：往右拖变宽（面板在边的左边）
//   dir = -1：往右拖变窄（面板在边的右边）
import { refitMid } from './measure.js';

const store = {
  get(k) {
    try {
      const v = Number(localStorage.getItem('bm-size:' + k));
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      v == null ? localStorage.removeItem('bm-size:' + k) : localStorage.setItem('bm-size:' + k, String(Math.round(v)));
    } catch { /* 无痕模式 */ }
  },
};

export function resizer(handle, { target, prop, key, min = 120, max = 1200, dir = 1, def, onChange }) {
  if (!handle || !target) return;
  const clamp = (v) => Math.max(min, Math.min(typeof max === 'function' ? max() : max, v));
  const saved = store.get(key);
  if (saved != null) target.style.setProperty(prop, clamp(saved) + 'px');
  handle.classList.add('rz');
  if (!handle.dataset.tip) handle.dataset.tip = '拖动调整宽度，双击恢复';

  const current = () => {
    const v = parseFloat(getComputedStyle(target).getPropertyValue(prop));
    return Number.isFinite(v) ? v : def;
  };
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = clamp(current()); // 从实际能占的宽度开始算（比如列被挤窄了）
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('on');
    document.documentElement.classList.add('resizing');
    let last = w0;
    const move = (ev) => {
      last = clamp(w0 + dir * (ev.clientX - x0));
      target.style.setProperty(prop, last + 'px');
      onChange?.(last);
      refitMid();
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      handle.classList.remove('on');
      document.documentElement.classList.remove('resizing');
      if (last !== w0) store.set(key, last);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    target.style.removeProperty(prop);
    store.set(key, null);
    onChange?.(current());
    refitMid();
  });
  // 拖动柄上的点击不要冒泡成「点了这一行 / 这一列」
  handle.addEventListener('click', (e) => e.stopPropagation());
}
