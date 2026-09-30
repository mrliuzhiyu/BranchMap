// 文字宽度：用 pretext（Canvas 量字，不碰 DOM、不触发重排）。
// 主要用来给分支名做「中间省略」：feature/JIRA-1234-login-refactor → feature/JIRA…refactor，
// 前缀和结尾都留着——CSS 的 text-overflow 只能在末尾省略，做不到。
//
// 用法：名字放进 <span data-mid="全名">全名</span>，这个 span 自己的宽度就是能占的宽度（被 flex / max-width 限住）。
// 渲染出来就自动截好；面板拖宽、窗口变宽时 refitMid() 全部重算。
import { prepare, measureNaturalWidth } from '/vendor/pretext/layout.js';

const widths = new Map();
/** 一段单行文字在某字体下的宽度（px），按「字体 + 文字」缓存。 */
export function textWidth(text, font) {
  const k = font + '\n' + text;
  let w = widths.get(k);
  if (w === undefined) {
    w = measureNaturalWidth(prepare(text, font));
    if (widths.size > 5000) widths.clear();
    widths.set(k, w);
  }
  return w;
}

const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** 中间省略到 maxW 以内。开头至少保留第一段路径（feature/、fix/），剩下的前后各一半。 */
export function midText(text, font, maxW) {
  if (textWidth(text, font) <= maxW) return text;
  const g = [...seg.segment(text)].map((s) => s.segment);
  const slash = g.indexOf('/');
  const prefix = slash >= 0 && slash < 12 ? slash + 1 : 0;
  const cut = (k) => {
    const head = Math.min(k, Math.max(prefix, Math.ceil(k / 2)));
    return g.slice(0, head).join('') + '…' + (k > head ? g.slice(g.length - (k - head)).join('') : '');
  };
  // 二分：最多留几个字还放得下
  let lo = 0;
  let hi = g.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(cut(mid), font) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return cut(lo);
}

// system-ui / -apple-system 在 Canvas 里量不准（pretext 的已知限制），换成具体字体名
const fonts = new Map();
function fontOf(el) {
  const cs = getComputedStyle(el);
  const k = cs.fontStyle + cs.fontWeight + cs.fontSize + cs.fontFamily;
  let f = fonts.get(k);
  if (!f) {
    const family = cs.fontFamily.split(',').map((s) => s.trim()).filter((s) => !/^(system-ui|-apple-system|BlinkMacSystemFont)$/i.test(s)).join(', ');
    fonts.set(k, (f = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${family || 'sans-serif'}`));
  }
  return f;
}

/** 把 root 里的 [data-mid] 都按自己现在能占的宽度截好。先全部写回全名，再一次读完宽度，最后一次写（只重排一次）。 */
export function fitMid(root = document) {
  const els = [...root.querySelectorAll('[data-mid]')];
  if (root.matches?.('[data-mid]')) els.push(root);
  if (!els.length) return;
  for (const el of els) if (el.textContent !== el.dataset.mid) el.textContent = el.dataset.mid;
  // 放得下的不动；放不下的按实际（带小数的）宽度截，留 0.5px 免得和 CSS 差一点点又被末尾省略
  const ws = els.map((el) => (el.scrollWidth > el.clientWidth ? el.getBoundingClientRect().width : 0));
  els.forEach((el, i) => {
    if (!ws[i]) return; // 放得下，或者没显示出来（display:none，显示时再算）
    const t = midText(el.dataset.mid, fontOf(el), ws[i] - 0.5);
    if (t !== el.textContent) el.textContent = t;
  });
}

let raf = 0;
/** 宽度变了（拖面板、窗口缩放）：下一帧全部重算。 */
export function refitMid() {
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; fitMid(); });
}

/** 新渲染出来的 [data-mid] 在绘制前自动截好（MutationObserver 在微任务里跑，看不到闪一下）。 */
export function watchMid() {
  new MutationObserver((recs) => {
    const roots = new Set();
    for (const r of recs) for (const n of r.addedNodes) if (n.nodeType === 1 && (n.matches('[data-mid]') || n.querySelector('[data-mid]'))) roots.add(n);
    for (const n of roots) if (n.isConnected) fitMid(n);
  }).observe(document.body, { childList: true, subtree: true });
  addEventListener('resize', refitMid);
}
