// 通用小工具：转义、时间、数字、图标、头像、提示框、弹出选择。

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const nowSec = () => Math.floor(Date.now() / 1000);
export const DAY = 86400;

/* ---------- 时间 ---------- */
export function ago(t) {
  if (!t) return '—';
  const s = nowSec() - t;
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.round(s / 60) + ' 分钟前';
  if (s < DAY) return Math.round(s / 3600) + ' 小时前';
  if (s < 30 * DAY) return Math.round(s / DAY) + ' 天前';
  return day(t);
}
export function day(t) {
  const d = new Date(t * 1000);
  const y = d.getFullYear() === new Date().getFullYear() ? '' : d.getFullYear() + '年';
  return `${y}${d.getMonth() + 1}月${d.getDate()}日`;
}
export function stamp(t) {
  if (!t) return '—';
  const d = new Date(t * 1000);
  return `${day(t)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function fullStamp(t) {
  const d = new Date(t * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
/** 列表里的日期：一周内说「x 天前」，更早说日期。 */
export function when(t) {
  return nowSec() - t < 7 * DAY ? ago(t) : stamp(t);
}
/** 本地时区的「那一天」0 点（秒）。 */
export function dayStart(t) {
  const d = new Date(t * 1000);
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000;
}
/** 那一周的周一 0 点（秒）。 */
export function weekStart(t) {
  const d = new Date(t * 1000);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime() / 1000;
}

/* ---------- 数字 ---------- */
export const num = (n) => (n ?? 0).toLocaleString('en-US');
export function compact(n) {
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return num(n);
}
export function aheadBehind(ahead, behind, { title = '' } = {}) {
  const a = ahead ? `<span class="up">↑${ahead}</span>` : '<span class="zero">↑0</span>';
  const b = behind ? `<span class="down">↓${behind}</span>` : '<span class="zero">↓0</span>';
  return `<span class="ab" title="${esc(title)}">${a} ${b}</span>`;
}
export function lineStat(add, del) {
  if (add == null && del == null) return '';
  return `<span class="lines">${add ? `<span class="a">+${num(add)}</span>` : ''}${add && del ? ' ' : ''}${del ? `<span class="d">−${num(del)}</span>` : ''}${!add && !del ? '<span class="faint">0</span>' : ''}</span>`;
}
/** GitHub 风格的 5 格增删条。 */
export function bar5(add, del) {
  const t = (add ?? 0) + (del ?? 0);
  if (!t) return '<span class="bar2"><i></i><i></i><i></i><i></i><i></i></span>';
  const a = Math.round((add / t) * 5);
  const cells = [];
  for (let i = 0; i < 5; i++) cells.push(`<i class="${i < a ? 'a' : 'd'}"></i>`);
  return `<span class="bar2">${cells.join('')}</span>`;
}

/* ---------- 图标（16px 线框，GitHub Octicons 风格） ---------- */
const svg = (d, s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${d}</svg>`;
export const icon = {
  branch: (s) => svg('<path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.5 2.5 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/>', s),
  commit: (s) => svg('<path d="M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/>', s),
  merge: (s) => svg('<path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z"/>', s),
  tag: (s) => svg('<path d="M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.752 1.752 0 0 1 1 7.775Zm1.5 0c0 .066.026.13.073.177l6.25 6.25a.25.25 0 0 0 .354 0l5.025-5.025a.25.25 0 0 0 0-.354l-6.25-6.25a.25.25 0 0 0-.177-.073H2.75a.25.25 0 0 0-.25.25ZM6 5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"/>', s),
  cloud: (s) => svg('<path d="M2 9.5A3.5 3.5 0 0 1 5.5 6h.1a4.5 4.5 0 0 1 8.4 2.2A2.75 2.75 0 0 1 13.25 14H5.5A3.5 3.5 0 0 1 2 10.5Zm3.5-2a2 2 0 0 0 0 5h7.75a1.25 1.25 0 0 0 .25-2.475.75.75 0 0 1-.6-.735V9a3 3 0 0 0-5.84-.99.75.75 0 0 1-.71.49Z"/>', s),
  folder: (s) => svg('<path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"/>', s),
  file: (s) => svg('<path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"/>', s),
  graph: (s) => svg('<path d="M1.5 1.75V13.5h13.75a.75.75 0 0 1 0 1.5H.75a.75.75 0 0 1-.75-.75V1.75a.75.75 0 0 1 1.5 0Zm14.28 2.53-5.25 5.25a.75.75 0 0 1-1.06 0L7 7.06 4.28 9.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.25-3.25a.75.75 0 0 1 1.06 0L10 7.94l4.72-4.72a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z"/>', s),
  home: (s) => svg('<path d="M6.906.664a1.749 1.749 0 0 1 2.187 0l5.25 4.2c.415.332.657.835.657 1.367v7.019A1.75 1.75 0 0 1 13.25 15h-3.5a.75.75 0 0 1-.75-.75V9H7v5.25a.75.75 0 0 1-.75.75h-3.5A1.75 1.75 0 0 1 1 13.25V6.23c0-.531.242-1.034.657-1.366l5.25-4.2Zm1.25 1.171a.25.25 0 0 0-.312 0l-5.25 4.2a.25.25 0 0 0-.094.196v7.019c0 .138.112.25.25.25H5.5V8.25a.75.75 0 0 1 .75-.75h3.5a.75.75 0 0 1 .75.75v5.25h2.75a.25.25 0 0 0 .25-.25V6.23a.25.25 0 0 0-.094-.195Z"/>', s),
  people: (s) => svg('<path d="M2 5.5a3.5 3.5 0 1 1 5.898 2.549 5.508 5.508 0 0 1 3.034 4.084.75.75 0 1 1-1.482.235 4 4 0 0 0-7.9 0 .75.75 0 0 1-1.482-.236A5.507 5.507 0 0 1 3.102 8.05 3.493 3.493 0 0 1 2 5.5ZM11 4a3.001 3.001 0 0 1 2.22 5.018 5.01 5.01 0 0 1 2.56 3.012.749.749 0 0 1-.885.954.752.752 0 0 1-.549-.514 3.507 3.507 0 0 0-2.522-2.372.75.75 0 0 1-.574-.73v-.352a.75.75 0 0 1 .416-.672A1.5 1.5 0 0 0 11 5.5.75.75 0 0 1 11 4Zm-5.5-.5a2 2 0 1 0-.001 3.999A2 2 0 0 0 5.5 3.5Z"/>', s),
  pulse: (s) => svg('<path d="M6 2c.306 0 .582.187.696.471L10 10.731l1.304-3.26A.751.751 0 0 1 12 7h3.25a.75.75 0 0 1 0 1.5h-2.742l-1.812 4.528a.751.751 0 0 1-1.392 0L6 4.77 4.696 8.03A.75.75 0 0 1 4 8.5H.75a.75.75 0 0 1 0-1.5h2.742l1.812-4.529A.751.751 0 0 1 6 2Z"/>', s),
  eye: (s) => svg('<path d="M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.931 2.637-3.022C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.825.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z"/>', s),
  search: (s) => svg('<path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"/>', s),
  sync: (s) => svg('<path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"/>', s),
  close: (s) => svg('<path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/>', s),
  chevronDown: (s) => svg('<path d="M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.939l3.72-3.719a.749.749 0 0 1 1.06 0Z"/>', s),
  chevronRight: (s) => svg('<path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"/>', s),
  arrowLeft: (s) => svg('<path d="M7.78 12.53a.75.75 0 0 1-1.06 0L2.47 8.28a.75.75 0 0 1 0-1.06l4.25-4.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L4.81 7h7.44a.75.75 0 0 1 0 1.5H4.81l2.97 2.97a.75.75 0 0 1 0 1.06Z"/>', s),
  arrowSwap: (s) => svg('<path d="M5.22 14.78a.75.75 0 0 0 1.06-1.06L4.56 12h8.69a.75.75 0 0 0 0-1.5H4.56l1.72-1.72a.75.75 0 0 0-1.06-1.06l-3 3a.75.75 0 0 0 0 1.06l3 3Zm5.56-6.5a.75.75 0 1 1-1.06-1.06l1.72-1.72H2.75a.75.75 0 0 1 0-1.5h8.69L9.72 2.28a.75.75 0 0 1 1.06-1.06l3 3a.75.75 0 0 1 0 1.06l-3 3Z"/>', s),
  copy: (s) => svg('<path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/>', s),
  ext: (s) => svg('<path d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z"/>', s),
  sun: (s) => svg('<path d="M8 12a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm0-1.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm5.657-8.157a.75.75 0 0 1 0 1.061l-1.061 1.06a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l1.06-1.06a.75.75 0 0 1 1.06 0Zm-9.193 9.193a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 1 1-1.061-1.06l1.06-1.061a.75.75 0 0 1 1.061 0ZM8 0a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0ZM3 8a.75.75 0 0 1-.75.75H.75a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 3 8Zm13 0a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 16 8Zm-8 5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13Zm3.536-1.464a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 0 1-1.06 1.061l-1.061-1.06a.75.75 0 0 1 0-1.061ZM2.343 2.343a.75.75 0 0 1 1.061 0l1.06 1.061a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-1.06-1.06a.75.75 0 0 1 0-1.06Z"/>', s),
  moon: (s) => svg('<path d="M9.598 1.591a.749.749 0 0 1 .785-.175 7.001 7.001 0 1 1-8.967 8.967.75.75 0 0 1 .961-.96 5.5 5.5 0 0 0 7.046-7.046.75.75 0 0 1 .175-.786Zm1.616 1.945a7 7 0 0 1-7.678 7.678 5.499 5.499 0 1 0 7.678-7.678Z"/>', s),
  alert: (s) => svg('<path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/>', s),
  check: (s) => svg('<path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>', s),
  pencil: (s) => svg('<path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"/>', s),
  server: (s) => svg('<path d="M1.75 1h12.5c.966 0 1.75.784 1.75 1.75v4c0 .372-.116.717-.314 1 .198.283.314.628.314 1v4a1.75 1.75 0 0 1-1.75 1.75H1.75A1.75 1.75 0 0 1 0 12.75v-4c0-.358.109-.707.314-1a1.739 1.739 0 0 1-.314-1v-4C0 1.784.784 1 1.75 1ZM1.5 2.75v4c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-4a.25.25 0 0 0-.25-.25H1.75a.25.25 0 0 0-.25.25Zm.25 5.75a.25.25 0 0 0-.25.25v4c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-4a.25.25 0 0 0-.25-.25ZM7 4.75A.75.75 0 0 1 7.75 4h4.5a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 7 4.75ZM7.75 10h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM3 4.75A.75.75 0 0 1 3.75 4h.5a.75.75 0 0 1 0 1.5h-.5A.75.75 0 0 1 3 4.75ZM3.75 10h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1 0-1.5Z"/>', s),
  package: (s) => svg('<path d="m8.878.392 5.25 3.045c.54.314.872.89.872 1.514v6.098a1.75 1.75 0 0 1-.872 1.514l-5.25 3.045a1.75 1.75 0 0 1-1.756 0l-5.25-3.045A1.75 1.75 0 0 1 1 11.049V4.951c0-.624.332-1.201.872-1.514L7.122.392a1.75 1.75 0 0 1 1.756 0ZM7.875 1.69l-4.63 2.685L8 7.133l4.755-2.758-4.63-2.685a.248.248 0 0 0-.25 0ZM2.5 5.677v5.372c0 .09.047.171.125.216l4.625 2.683V8.432Zm6.25 8.271 4.625-2.683a.25.25 0 0 0 .125-.216V5.677L8.75 8.432Z"/>', s),
  desktop: (s) => svg('<path d="M14.25 1c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 14.25 12h-3.727c.099 1.041.52 1.872 1.292 2.757A.752.752 0 0 1 11.25 16h-6.5a.75.75 0 0 1-.565-1.243c.772-.885 1.192-1.716 1.292-2.757H1.75A1.75 1.75 0 0 1 0 10.25v-7.5C0 1.784.784 1 1.75 1ZM1.75 2.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25ZM9.018 12H6.982a5.72 5.72 0 0 1-.765 2.5h3.566a5.72 5.72 0 0 1-.765-2.5Z"/>', s),
  info: (s) => svg('<path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/>', s),
  xCircle: (s) => svg('<path d="M2.343 13.657A8 8 0 1 1 13.658 2.343 8 8 0 0 1 2.343 13.657ZM6.03 4.97a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042L6.94 8 4.97 9.97a.749.749 0 0 0 .326 1.275.749.749 0 0 0 .734-.215L8 9.06l1.97 1.97a.749.749 0 0 0 1.275-.326.749.749 0 0 0-.215-.734L9.06 8l1.97-1.97a.749.749 0 0 0-.326-1.275.749.749 0 0 0-.734.215L8 6.94Z"/>', s),
  checkCircle: (s) => svg('<path d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16Zm3.78-9.72a.751.751 0 0 0-.018-1.042.751.751 0 0 0-1.042-.018L6.75 9.19 5.28 7.72a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042l2 2a.75.75 0 0 0 1.06 0Z"/>', s),
  clock: (s) => svg('<path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm7-3.25v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5a.75.75 0 0 1 1.5 0Z"/>', s),
  arrowRight: (s) => svg('<path d="M8.22 2.97a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l2.97-2.97H3.75a.75.75 0 0 1 0-1.5h7.44L8.22 4.03a.75.75 0 0 1 0-1.06Z"/>', s),
  arrowUp: (s) => svg('<path d="M3.47 7.78a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0l4.25 4.25a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018L9 4.81v7.44a.75.75 0 0 1-1.5 0V4.81L4.53 7.78a.75.75 0 0 1-1.06 0Z"/>', s),
  arrowDown: (s) => svg('<path d="M13.03 8.22a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L3.47 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018l2.97 2.97V3.75a.75.75 0 0 1 1.5 0v7.44l2.97-2.97a.75.75 0 0 1 1.06 0Z"/>', s),
  pr: (s) => svg('<path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/>', s),
  issue: (s) => svg('<path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/>', s),
  archive: (s) => svg('<path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v1.5A1.75 1.75 0 0 1 14.5 5.995v7.255A1.75 1.75 0 0 1 12.75 15h-9.5A1.75 1.75 0 0 1 1.5 13.25V5.995A1.75 1.75 0 0 1 0 4.25ZM3 6v7.25c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6Zm-1.25-3.5a.25.25 0 0 0-.25.25v1.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-1.5a.25.25 0 0 0-.25-.25ZM6.25 8h3.5a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1 0-1.5Z"/>', s),
  flow: (s) => svg('<path d="M0 1.75C0 .784.784 0 1.75 0h3.5C6.216 0 7 .784 7 1.75v3.5A1.75 1.75 0 0 1 5.25 7H4v4a1 1 0 0 0 1 1h4v-1.25C9 9.784 9.784 9 10.75 9h3.5c.966 0 1.75.784 1.75 1.75v3.5A1.75 1.75 0 0 1 14.25 16h-3.5A1.75 1.75 0 0 1 9 14.25v-.75H5A2.5 2.5 0 0 1 2.5 11V7h-.75A1.75 1.75 0 0 1 0 5.25Zm1.75-.25a.25.25 0 0 0-.25.25v3.5c0 .138.112.25.25.25h3.5a.25.25 0 0 0 .25-.25v-3.5a.25.25 0 0 0-.25-.25Zm9 9a.25.25 0 0 0-.25.25v3.5c0 .138.112.25.25.25h3.5a.25.25 0 0 0 .25-.25v-3.5a.25.25 0 0 0-.25-.25Z"/>', s),
  github: (s) => svg('<path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/>', s),
  repo: (s) => svg('<path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"/>', s),
  gear: (s) => svg('<path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073-.159.059-.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z"/>', s),
  plus: (s) => svg('<path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z"/>', s),
  sidebar: (s) => svg('<path d="M1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75C0 1.784.784 1 1.75 1ZM1.5 2.75v10.5c0 .138.112.25.25.25H5v-11H1.75a.25.25 0 0 0-.25.25ZM6.5 13.5h7.75a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25H6.5Z"/>', s),
  kebab: (s) => svg('<path d="M8 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM1.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm13 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/>', s),
  logo: (s) => `<svg width="${s || 20}" height="${s || 20}" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="5" cy="4" r="2.4" fill="currentColor"/><circle cx="5" cy="16" r="2.4" fill="currentColor"/><circle cx="15" cy="7.5" r="2.4" fill="currentColor"/><path d="M5 6.5v7M15 10c0 3-4 3.6-10 3.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
};

/* ---------- 状态：颜色之外一定配图标和文字 ---------- */
export const LEVEL = {
  critical: { icon: 'xCircle', label: '严重' },
  warning: { icon: 'alert', label: '注意' },
  info: { icon: 'info', label: '提示' },
  good: { icon: 'checkCircle', label: '正常' },
};
export function levelIcon(level, size = 14) {
  return `<span class="lv lv-${level}" aria-label="${LEVEL[level]?.label ?? ''}">${icon[LEVEL[level]?.icon ?? 'info'](size)}</span>`;
}
/** 项目 / 快照的整体健康：有严重 → critical，有注意 → warning，否则 good。 */
export function worst(h) {
  if (!h) return 'info';
  if (h.critical) return 'critical';
  if (h.warning) return 'warning';
  return 'good';
}
/** 几个人的头像叠在一起。 */
export function avatarStack(persons, ids, { max = 4, size = 20 } = {}) {
  const list = ids.map((id) => persons[id]).filter(Boolean);
  const shown = list.slice(0, max);
  const rest = list.length - shown.length;
  return `<span class="avs">${shown.map((p) => avatar(p, size)).join('')}${rest > 0 ? `<span class="av s${size} more" data-tip="${esc(list.slice(max).map((p) => p.name).join('、'))}">+${rest}</span>` : ''}</span>`;
}
/** 时长：秒 → 「3 小时」 */
export function span(sec) {
  if (sec < 3600) return Math.max(1, Math.round(sec / 60)) + ' 分钟';
  if (sec < DAY) return Math.round(sec / 3600) + ' 小时';
  return Math.round(sec / DAY) + ' 天';
}

/* ---------- 头像 ---------- */
export function avatar(p, size = 20, extraTitle = '') {
  const name = p?.name ?? '?';
  const initial = esc([...name.trim()][0]?.toUpperCase() ?? '?');
  const img = p?.avatar ? `<img src="${esc(p.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
  const bg = p?.color ? `background:${p.color}` : '';
  return `<span class="av s${size}" style="${bg}" data-tip="${esc(name + (extraTitle ? ' · ' + extraTitle : ''))}">${initial}${img}</span>`;
}
export function who(p, size = 18) {
  return `<span class="who">${avatar(p, size)}<span class="ell">${esc(p?.name ?? '?')}</span></span>`;
}

/* ---------- 提示框：任何带 data-tip 的元素悬停显示 ----------
   纯文字的 data-tip 自动排版成一张小卡片：
     第一行 = 标题（加粗；元素上有 data-tip-c 时标题前是那个颜色的点，比如分支色）
     其余行 = 正文；「键：值」短键的行排成两列；「● 名字 / ○ 名字」画成实心 / 空心圆点
     「点击…」「点一下…」这类操作说明 = 底部的小字
   需要更丰富的内容（多种颜色、头像）用 tipCard() 生成 HTML，元素上加 data-tip-html。 */
const tip = () => document.getElementById('tip');
const HINT = /^(点击|点一下|点开|按住|拖|双击|右键|回车)/;
function tipLine(l) {
  const dot = /^([●○])\s*(.*)$/.exec(l);
  if (dot) return `<div class="tdot${dot[1] === '●' ? ' on' : ''}"><i></i><span>${esc(dot[2])}</span></div>`;
  const kv = /^([^：:\s]{1,6})[：:]\s*(.+)$/.exec(l);
  if (kv) return `<div class="tkv"><span>${esc(kv[1])}</span><b>${esc(kv[2])}</b></div>`;
  return `<div class="tb">${esc(l)}</div>`;
}
function formatTip(text, color) {
  const lines = String(text ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return '';
  const dot = color ? `<i class="tc" style="background:${esc(color)}"></i>` : '';
  if (lines.length === 1 && !color) return `<div class="t1">${esc(lines[0])}</div>`;
  const first = /^[●○]/.test(lines[0]) ? null : lines.shift();
  const hint = lines.filter((l) => HINT.test(l));
  const body = lines.filter((l) => !HINT.test(l));
  return `${first ? `<div class="tt">${dot}<span>${esc(first)}</span></div>` : ''}${body.map(tipLine).join('')}${hint.length ? `<div class="th">${hint.map(esc).join('<br>')}</div>` : ''}`;
}
/**
 * 结构化提示卡片（返回 HTML，放进 data-tip 并加 data-tip-html）：
 *   c 标题前的颜色点；title 标题；sub 标题下一行淡字；
 *   rows [[键, 值HTML]]；lines 正文（纯文字）；dots [{ on, c, label, env }] 一串站点（走到哪了）；hint 底部操作说明
 * 值 HTML 由调用方负责转义。
 */
export function tipCard({ c = null, title, sub = null, rows = [], dots = [], lines = [], hint = null }) {
  return `<div class="tt">${c ? `<i class="tc" style="background:${esc(c)}"></i>` : ''}<span>${esc(title)}</span></div>
    ${sub ? `<div class="ts">${sub}</div>` : ''}
    ${rows.length ? `<div class="tkvs">${rows.map(([k, v]) => `<div class="tkv"><span>${esc(k)}</span><b>${v}</b></div>`).join('')}</div>` : ''}
    ${lines.map((l) => `<div class="tb">${esc(l)}</div>`).join('')}
    ${dots.length ? `<div class="tdots">${dots.map((d) => `<div class="tdot${d.on ? ' on' : ''}${d.env ? ' is-env' : ''}" style="--c:${esc(d.c ?? 'var(--text)')}"><i></i><span>${esc(d.label)}</span></div>`).join('')}</div>` : ''}
    ${hint ? `<div class="th">${esc(hint)}</div>` : ''}`;
}
const tipHtmlOf = (t) => ('tipHtml' in t.dataset ? t.dataset.tip : formatTip(t.dataset.tip, t.dataset.tipC));
let tipOwner = null;
export function showTip(x, y, html) {
  const el = tip();
  el.innerHTML = html;
  el.hidden = false;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  el.style.left = Math.max(8, Math.min(x + 14, innerWidth - w - 8)) + 'px';
  el.style.top = (y + 18 + h > innerHeight - 8 ? y - h - 12 : y + 18) + 'px';
}
export function hideTip() {
  tip().hidden = true;
  tipOwner = null;
}
/** 显示了省略号的文字（被截断了）：没有别的提示时，悬停显示全文。 */
function truncatedAt(el) {
  for (let x = el, i = 0; x && x.nodeType === 1 && i < 3; x = x.parentElement, i++) {
    if (x.scrollWidth > x.clientWidth + 1 && getComputedStyle(x).textOverflow === 'ellipsis') return x;
  }
  return null;
}
// 第一次悬停等一会儿再出（扫过列表不闪）；已经有提示在显示时，移到下一个立刻换
const TIP_DELAY = 300;
let tipTimer = 0;
let tipWarmUntil = 0;
let tipX = 0;
let tipY = 0;
document.addEventListener('mousemove', (e) => {
  tipX = e.clientX;
  tipY = e.clientY;
  const t = e.target.closest?.('[data-tip]');
  const cut = t ? null : truncatedAt(e.target);
  const owner = t ?? cut;
  if (!owner) {
    clearTimeout(tipTimer);
    tipTimer = 0;
    if (tipOwner) {
      hideTip();
      tipWarmUntil = Date.now() + 400;
    }
    return;
  }
  const html = t ? tipHtmlOf(t) : `<div class="t1">${esc(cut.textContent.trim())}</div>`;
  const show = () => {
    tipTimer = 0;
    tipOwner = owner;
    showTip(tipX, tipY, html);
  };
  clearTimeout(tipTimer);
  if (tipOwner || Date.now() < tipWarmUntil) return show();
  tipTimer = setTimeout(show, TIP_DELAY);
});
// 键盘 Tab 到带提示的按钮上，也显示提示（贴在它下面）
document.addEventListener('focusin', (e) => {
  const t = e.target.closest?.('[data-tip]');
  if (!t || !e.target.matches(':focus-visible')) return;
  const r = t.getBoundingClientRect();
  clearTimeout(tipTimer);
  tipOwner = t;
  showTip(r.left, r.bottom - 12, tipHtmlOf(t));
});
document.addEventListener('focusout', () => tipOwner && hideTip());
document.addEventListener('mouseleave', () => {
  clearTimeout(tipTimer);
  if (tipOwner) hideTip();
});
document.addEventListener('scroll', () => tipOwner && hideTip(), true);

/* ---------- 轻提示 ---------- */
let toastTimer;
export function toast(text) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.append(el);
  }
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2200);
}
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制 ' + (text.length > 40 ? text.slice(0, 40) + '…' : text));
  } catch {
    toast('复制失败');
  }
}

/* ---------- 弹出选择（单选 / 多选，带搜索） ----------
   items: [{ value, label, html?, group?, hint? }] */
let openPop = null;
export function closePop() {
  openPop?.remove();
  openPop = null;
}
export function picker(anchor, { items, multi = false, selected = [], placeholder = '搜索', onPick, footer = null, width = 320 }) {
  closePop();
  const sel = new Set(selected);
  const pop = document.createElement('div');
  pop.className = 'pop';
  pop.style.width = width + 'px';
  pop.innerHTML = `<div class="pop-search"><label class="input">${icon.search(13)}<input placeholder="${esc(placeholder)}" autocomplete="off"></label></div><div class="pop-list"></div>${multi || footer ? '<div class="pop-foot"></div>' : ''}`;
  document.body.append(pop);
  openPop = pop;
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, innerWidth - width - 8)) + 'px';
  pop.style.top = r.bottom + 6 + 'px';
  pop.style.maxHeight = Math.max(240, innerHeight - r.bottom - 24) + 'px';
  const input = pop.querySelector('input');
  const list = pop.querySelector('.pop-list');
  let kb = -1;
  let shown = [];
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    shown = items.filter((it) => !q || String(it.label).toLowerCase().includes(q) || String(it.hint ?? '').toLowerCase().includes(q)).slice(0, 400);
    let lastGroup = null;
    list.innerHTML = shown.map((it, i) => {
      const g = it.group && it.group !== lastGroup ? `<div class="pop-grp">${esc(it.group)}</div>` : '';
      lastGroup = it.group ?? lastGroup;
      return `${g}<button class="opt${i === kb ? ' kb' : ''}" data-i="${i}" aria-selected="${sel.has(it.value)}">${multi ? `<span class="ck">${sel.has(it.value) ? icon.check(13) : ''}</span>` : ''}${it.html ?? `<span class="ell">${esc(it.label)}</span>`}${it.hint ? `<span class="faint" style="margin-left:auto;font-size:11.5px">${esc(it.hint)}</span>` : ''}</button>`;
    }).join('') || '<div class="empty">没有匹配的</div>';
  };
  const choose = (it) => {
    if (multi) {
      sel.has(it.value) ? sel.delete(it.value) : sel.add(it.value);
      draw();
      onPick([...sel]);
    } else {
      closePop();
      onPick(it.value);
    }
  };
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (b) choose(shown[Number(b.dataset.i)]);
  });
  input.addEventListener('input', () => { kb = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { kb = Math.min(shown.length - 1, kb + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { kb = Math.max(0, kb - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter' && shown[Math.max(0, kb)]) { choose(shown[Math.max(0, kb)]); e.preventDefault(); }
    else if (e.key === 'Escape') closePop();
  });
  if (multi || footer) {
    const foot = pop.querySelector('.pop-foot');
    foot.innerHTML = footer ?? '<button class="btn sm ghost" data-clear>清空</button><button class="btn sm" data-done>完成</button>';
    foot.addEventListener('click', (e) => {
      if (e.target.closest('[data-clear]')) { sel.clear(); draw(); onPick([]); }
      if (e.target.closest('[data-done]')) closePop();
    });
  }
  draw();
  setTimeout(() => input.focus(), 0);
  return pop;
}
document.addEventListener('mousedown', (e) => {
  if (openPop && !openPop.contains(e.target) && !e.target.closest('[data-pop-anchor]')) closePop();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openPop) closePop();
});

/* ---------- 路径 ---------- */
export function splitPath(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
}
export function filePath(p) {
  const [dir, base] = splitPath(p);
  // 目录和文件名分两段：放不下时先从左边省略目录，文件名尽量完整
  return `<span class="fp" title="${esc(p)}">${dir ? `<span class="dir"><span dir="ltr">${esc(dir)}</span></span>` : ''}<span class="base">${esc(base)}</span></span>`;
}
export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i;

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/** 文件名在前、目录在后（目录淡、放不下就截断目录），列表里一眼能看到改的是哪个文件 */
export function fileName(p) {
  const [dir, base] = splitPath(p);
  return `<span class="fn" title="${esc(p)}"><b>${esc(base)}</b><span class="dir">${esc(dir.replace(/\/$/, ''))}</span></span>`;
}

/* ---------- PR：编号 + CI + 审核 ---------- */
const PR_STATE = { OPEN: '打开', DRAFT: '草稿', MERGED: '已合并', CLOSED: '已关闭' };
const REVIEW = { APPROVED: '审核：已批准', CHANGES_REQUESTED: '审核：要求修改', REVIEW_REQUIRED: '审核：等待审核' };
/**
 * PR 标记：#编号，后面跟 CI（✓ 通过 / ✗ 失败 / ● 运行中）和审核（已批准 / 要求修改）的小图标。
 * mini 只留图标状态（左栏），full 带标题（详情）。点击去 GitHub。
 */
export function prChip(pr, { mini = false, full = false } = {}) {
  if (!pr) return '';
  const ci = pr.ci;
  const lines = [`PR #${pr.n} ${pr.title ?? ''}`, `状态：${PR_STATE[pr.state] ?? pr.state}`];
  if (pr.review && REVIEW[pr.review]) lines.push(REVIEW[pr.review]);
  if (ci) lines.push(ci.state === 'pass' ? `CI：通过（${ci.pass} 项）` : ci.state === 'fail' ? `CI：失败 ${ci.fail} 项${ci.failed.length ? '：' + ci.failed.join('、') : ''}` : `CI：运行中 ${ci.pending} 项`);
  const ciIc = ci ? `<i class="ci ${ci.state}">${ci.state === 'pass' ? icon.check(10) : ci.state === 'fail' ? icon.close(10) : ''}</i>` : '';
  const rvIc = pr.review === 'APPROVED' ? `<i class="rv ok">${icon.checkCircle(10)}</i>` : pr.review === 'CHANGES_REQUESTED' ? `<i class="rv bad">${icon.alert(10)}</i>` : '';
  if (mini) return ci || rvIc ? `<span class="prm" data-tip="${esc(lines.join('\n'))}">${ciIc}${rvIc}</span>` : '';
  return `<a class="pr ${pr.state}${full ? ' full' : ''}" href="${esc(pr.url ?? '#')}" target="_blank" rel="noreferrer" data-tip="${esc(lines.join('\n'))}">${full ? icon.pr(12) : ''}#${pr.n}${full ? `<span class="pt">${esc(pr.title ?? '')}</span>` : ''}${ciIc}${rvIc}</a>`;
}
