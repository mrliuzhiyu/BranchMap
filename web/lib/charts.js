// 手写 SVG 图表：堆叠柱、上下对称柱（增/删）、面积线、日历热力图、星期×小时热力格、迷你柱。
// 规范：细柱（≤24px）、4px 圆角数据端、2px 表面色间隙、发丝网格；悬停出提示，数值加粗在前、名称在后。
import { esc, compact, num, showTip, hideTip, day } from './util.js';

const SEQ = ['var(--seq0)', 'var(--seq2)', 'var(--seq3)', 'var(--seq4)', 'var(--seq5)', 'var(--seq6)'];

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
/** 画在 el 里，宽度变了自动重画。 */
function mountChart(el, draw) {
  el._draw = draw;
  draw();
  if (!el._ro) {
    let w = el.clientWidth;
    el._ro = new ResizeObserver(() => {
      if (Math.abs(el.clientWidth - w) > 2) {
        w = el.clientWidth;
        el._draw?.();
      }
    });
    el._ro.observe(el);
  }
}
function roundTop(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
function roundBottom(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w - r}Q${x + w},${y + h} ${x + w},${y + h - r}V${y}Z`;
}
const tipRow = (color, value, name, line = false) => `<div class="tr"><span class="key" style="background:${color};${line ? '' : 'height:8px;width:8px;border-radius:2px'}"></span><span class="tv">${value}</span><span class="tl">${esc(name)}</span></div>`;
function xLabelStep(n, band, px = 64) {
  return Math.max(1, Math.ceil(px / Math.max(band, 1)));
}

/** 堆叠柱：labels[i] 是 x，series[{ name, color, values }]。 */
export function columns(el, { labels, series, height = 200, xFmt = String, tipTitle = (i) => xFmt(labels[i]), unit = '' }) {
  mountChart(el, () => {
    const W = Math.max(200, el.clientWidth);
    const H = height;
    const m = { l: 40, r: 6, t: 10, b: 24 };
    const n = labels.length;
    const totals = labels.map((_, i) => series.reduce((s, x) => s + (x.values[i] || 0), 0));
    const max = niceMax(Math.max(1, ...totals));
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const band = iw / n;
    const bw = Math.min(24, Math.max(1.5, band * 0.72));
    const y = (v) => m.t + ih - (v / max) * ih;
    let g = '';
    for (let k = 0; k <= 4; k++) {
      const v = (max * k) / 4;
      g += `<line class="${k ? 'grid-l' : 'base-l'}" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`;
    }
    let bars = '';
    const step = xLabelStep(n, band);
    let xl = '';
    for (let i = 0; i < n; i++) {
      const x = m.l + i * band + (band - bw) / 2;
      let base = y(0);
      const segs = series.map((s) => ({ s, v: s.values[i] || 0 })).filter((z) => z.v > 0);
      segs.forEach((z, k) => {
        const h = (z.v / max) * ih;
        const top = base - h;
        const gap = k > 0 ? 2 : 0;
        const hh = Math.max(0.5, h - gap);
        bars += k === segs.length - 1 ? `<path d="${roundTop(x, top, bw, hh, 4)}" style="fill:${z.s.color}"/>` : `<rect x="${x}" y="${top}" width="${bw}" height="${hh}" style="fill:${z.s.color}"/>`;
        base = top;
      });
      if (i % step === 0) xl += `<text x="${m.l + i * band + band / 2}" y="${H - 6}" text-anchor="middle">${esc(xFmt(labels[i]))}</text>`;
    }
    const hits = labels.map((_, i) => `<rect class="hit" data-i="${i}" x="${m.l + i * band}" y="${m.t}" width="${band}" height="${ih}"/>`).join('');
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}">${g}<rect class="col-hl" x="0" y="${m.t}" width="0" height="${ih}"/>${bars}${xl}${hits}</svg>`;
    const hl = el.querySelector('.col-hl');
    el.onmousemove = (e) => {
      const t = e.target.closest?.('.hit');
      if (!t) { hl.setAttribute('width', 0); hideTip(); return; }
      const i = Number(t.dataset.i);
      hl.setAttribute('x', m.l + i * band);
      hl.setAttribute('width', band);
      const rows = [...series].reverse().filter((s) => s.values[i]).map((s) => tipRow(s.color, num(s.values[i]) + unit, s.name)).join('');
      showTip(e.clientX, e.clientY, `<div style="margin-bottom:4px"><b>${esc(tipTitle(i))}</b> · 共 ${num(totals[i])}${unit}</div>${rows || '<span class="tl">没有</span>'}`);
    };
    el.onmouseleave = () => { hl.setAttribute('width', 0); hideTip(); };
  });
}

/** 上下对称柱：上面是 up（新增），下面是 down（删除）。 */
export function mirrored(el, { labels, up, down, height = 200, xFmt = String, tipTitle = (i) => xFmt(labels[i]) }) {
  mountChart(el, () => {
    const W = Math.max(200, el.clientWidth);
    const H = height;
    const m = { l: 48, r: 6, t: 10, b: 24 };
    const n = labels.length;
    const max = niceMax(Math.max(1, ...up.values, ...down.values));
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const mid = m.t + ih / 2;
    const band = iw / n;
    const bw = Math.min(24, Math.max(1.5, band * 0.72));
    const sc = (v) => (v / max) * (ih / 2);
    let g = '';
    for (const k of [-1, -0.5, 0, 0.5, 1]) {
      const yy = mid - k * (ih / 2);
      g += `<line class="${k ? 'grid-l' : 'base-l'}" x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}"/><text x="${m.l - 6}" y="${yy + 4}" text-anchor="end">${k < 0 ? '−' : k > 0 ? '+' : ''}${compact(Math.abs(k) * max)}</text>`;
    }
    let bars = '';
    let xl = '';
    const step = xLabelStep(n, band);
    for (let i = 0; i < n; i++) {
      const x = m.l + i * band + (band - bw) / 2;
      const hu = sc(up.values[i] || 0);
      const hd = sc(down.values[i] || 0);
      if (hu > 0) bars += `<path d="${roundTop(x, mid - hu - 1, bw, Math.max(0.5, hu), 4)}" style="fill:${up.color}"/>`;
      if (hd > 0) bars += `<path d="${roundBottom(x, mid + 1, bw, Math.max(0.5, hd), 4)}" style="fill:${down.color}"/>`;
      if (i % step === 0) xl += `<text x="${m.l + i * band + band / 2}" y="${H - 6}" text-anchor="middle">${esc(xFmt(labels[i]))}</text>`;
    }
    const hits = labels.map((_, i) => `<rect class="hit" data-i="${i}" x="${m.l + i * band}" y="${m.t}" width="${band}" height="${ih}"/>`).join('');
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}">${g}<rect class="col-hl" x="0" y="${m.t}" width="0" height="${ih}"/>${bars}${xl}${hits}</svg>`;
    const hl = el.querySelector('.col-hl');
    el.onmousemove = (e) => {
      const t = e.target.closest?.('.hit');
      if (!t) { hl.setAttribute('width', 0); hideTip(); return; }
      const i = Number(t.dataset.i);
      hl.setAttribute('x', m.l + i * band);
      hl.setAttribute('width', band);
      showTip(e.clientX, e.clientY, `<div style="margin-bottom:4px"><b>${esc(tipTitle(i))}</b></div>${tipRow(up.color, '+' + num(up.values[i] || 0), up.name)}${tipRow(down.color, '−' + num(down.values[i] || 0), down.name)}`);
    };
    el.onmouseleave = () => { hl.setAttribute('width', 0); hideTip(); };
  });
}

/** 面积线（单条）：带竖线准星。 */
export function area(el, { labels, values, name, color = 'var(--s1)', height = 200, xFmt = String, tipTitle = (i) => xFmt(labels[i]) }) {
  mountChart(el, () => {
    const W = Math.max(200, el.clientWidth);
    const H = height;
    const m = { l: 48, r: 10, t: 10, b: 24 };
    const n = labels.length;
    const lo = Math.min(0, ...values);
    const max = niceMax(Math.max(1, ...values));
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const x = (i) => m.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
    const y = (v) => m.t + ih - ((v - lo) / (max - lo)) * ih;
    let g = '';
    for (let k = 0; k <= 4; k++) {
      const v = lo + ((max - lo) * k) / 4;
      g += `<line class="${k ? 'grid-l' : 'base-l'}" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${compact(Math.round(v))}</text>`;
    }
    const pts = values.map((v, i) => `${x(i)},${y(v)}`);
    const line = `M${pts.join('L')}`;
    const fill = `${line}L${x(n - 1)},${y(lo)}L${x(0)},${y(lo)}Z`;
    let xl = '';
    const step = xLabelStep(n, iw / Math.max(1, n));
    for (let i = 0; i < n; i += step) xl += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(xFmt(labels[i]))}</text>`;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}">${g}<path d="${fill}" style="fill:${color};opacity:.1"/><path d="${line}" style="fill:none;stroke:${color};stroke-width:2;stroke-linejoin:round;stroke-linecap:round"/>${n ? `<circle cx="${x(n - 1)}" cy="${y(values[n - 1])}" r="4" style="fill:${color};stroke:var(--surface);stroke-width:2"/>` : ''}<line class="xhair" visibility="hidden" y1="${m.t}" y2="${m.t + ih}" x1="0" x2="0"/><circle class="xdot" visibility="hidden" r="4" cx="0" cy="0" style="fill:${color};stroke:var(--surface);stroke-width:2"/>${xl}<rect class="hit" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}"/></svg>`;
    const xh = el.querySelector('.xhair');
    const dot = el.querySelector('.xdot');
    el.onmousemove = (e) => {
      const svg = el.querySelector('svg');
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      if (px < m.l - 4 || px > W - m.r + 4 || !n) { hideTip(); xh.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); return; }
      xh.setAttribute('visibility', 'visible');
      dot.setAttribute('visibility', 'visible');
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / iw) * (n - 1))));
      xh.setAttribute('x1', x(i));
      xh.setAttribute('x2', x(i));
      dot.setAttribute('cx', x(i));
      dot.setAttribute('cy', y(values[i]));
      showTip(e.clientX, e.clientY, `<div style="margin-bottom:4px"><b>${esc(tipTitle(i))}</b></div>${tipRow(color, num(values[i]), name, true)}`);
    };
    el.onmouseleave = () => { xh.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); hideTip(); };
  });
}

/** 分档：0 一档，其余按非零值的分位数分 5 档。 */
function buckets(values) {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!nz.length) return () => 0;
  const q = (p) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))];
  const th = [q(0.2), q(0.45), q(0.7), q(0.9)];
  return (v) => (v <= 0 ? 0 : v <= th[0] ? 1 : v <= th[1] ? 2 : v <= th[2] ? 3 : v <= th[3] ? 4 : 5);
}
export function scaleLegend(lo = '少', hi = '多') {
  return `<span class="scale">${lo}${SEQ.map((c) => `<i style="background:${c}"></i>`).join('')}${hi}</span>`;
}

/** 日历热力图：最近 weeks 周，每天一格。counts: Map(当天 0 点秒 → 数量)。 */
export function calendar(el, { counts, end, weeks = 53, label = '个提交' }) {
  mountChart(el, () => {
    const W = Math.max(300, el.clientWidth);
    const left = 26;
    const cell = Math.max(8, Math.min(18, Math.floor((W - left) / weeks) - 2));
    const gap = 2;
    const top = 16;
    const H = top + 7 * (cell + gap);
    const endD = new Date(end * 1000);
    endD.setHours(0, 0, 0, 0);
    const start = new Date(endD);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - (weeks - 1) * 7);
    const days = [];
    for (let d = new Date(start); d <= endD; d.setDate(d.getDate() + 1)) days.push(d.getTime() / 1000);
    const lvl = buckets(days.map((t) => counts.get(t) ?? 0));
    let cells = '';
    let months = '';
    let lastMonth = -1;
    days.forEach((t, i) => {
      const w = Math.floor(i / 7);
      const dow = i % 7;
      const v = counts.get(t) ?? 0;
      const x = left + w * (cell + gap);
      cells += `<rect class="cell" data-t="${t}" data-v="${v}" x="${x}" y="${top + dow * (cell + gap)}" width="${cell}" height="${cell}" rx="2" style="fill:${SEQ[lvl(v)]}"/>`;
      const mo = new Date(t * 1000).getMonth();
      if (dow === 0 && mo !== lastMonth) {
        if (lastMonth !== -1 || new Date(t * 1000).getDate() <= 7) months += `<text x="${x}" y="10">${mo + 1}月</text>`;
        lastMonth = mo;
      }
    });
    const wd = ['一', '', '三', '', '五', '', ''].map((s, i) => (s ? `<text x="0" y="${top + i * (cell + gap) + cell - 1}">${s}</text>` : '')).join('');
    el.innerHTML = `<svg class="cal" viewBox="0 0 ${W} ${H}" height="${H}">${months}${wd}${cells}</svg>`;
    el.onmousemove = (e) => {
      const c = e.target.closest?.('.cell');
      if (!c) { hideTip(); return; }
      showTip(e.clientX, e.clientY, `<span class="tv">${num(Number(c.dataset.v))}</span> <span class="tl">${label} · ${day(Number(c.dataset.t))}</span>`);
    };
    el.onmouseleave = hideTip;
  });
}

/** 星期 × 小时：grid[星期一..日][0..23]。 */
export function punchcard(el, { grid, label = '个提交' }) {
  mountChart(el, () => {
    const W = Math.max(300, el.clientWidth);
    const left = 30;
    const cell = Math.max(10, Math.min(26, Math.floor((W - left) / 24) - 3));
    const gap = 3;
    const top = 4;
    const H = top + 7 * (cell + gap) + 16;
    const lvl = buckets(grid.flat());
    const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    let out = '';
    grid.forEach((row, d) => {
      out += `<text x="0" y="${top + d * (cell + gap) + cell * 0.72}">${names[d]}</text>`;
      row.forEach((v, h) => {
        out += `<rect class="cell" data-d="${d}" data-h="${h}" data-v="${v}" x="${left + h * (cell + gap)}" y="${top + d * (cell + gap)}" width="${cell}" height="${cell}" rx="2" style="fill:${SEQ[lvl(v)]}"/>`;
      });
    });
    for (const h of [0, 3, 6, 9, 12, 15, 18, 21]) out += `<text x="${left + h * (cell + gap) + cell / 2}" y="${H - 2}" text-anchor="middle">${h}时</text>`;
    el.innerHTML = `<svg class="cal" viewBox="0 0 ${W} ${H}" height="${H}">${out}</svg>`;
    el.onmousemove = (e) => {
      const c = e.target.closest?.('.cell');
      if (!c) { hideTip(); return; }
      showTip(e.clientX, e.clientY, `<span class="tv">${num(Number(c.dataset.v))}</span> <span class="tl">${label} · ${names[c.dataset.d]} ${c.dataset.h}:00–${c.dataset.h}:59</span>`);
    };
    el.onmouseleave = hideTip;
  });
}

/** 行内迷你柱（字符串）：每个值一根，0 画成底线。 */
export function sparkBars(values, { w = 84, h = 20, color = 'var(--s1)', title = null } = {}) {
  const n = values.length;
  const max = Math.max(1, ...values);
  const band = w / n;
  const bw = Math.max(1, band - 1.5);
  let out = '';
  values.forEach((v, i) => {
    const x = i * band;
    if (v > 0) {
      const bh = Math.max(2, (v / max) * (h - 1));
      out += `<rect x="${x.toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="1" style="fill:${color}"/>`;
    } else out += `<rect x="${x.toFixed(1)}" y="${h - 1}" width="${bw.toFixed(1)}" height="1" style="fill:var(--line-2)"/>`;
  });
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${title ? ` data-tip="${esc(title)}"` : ''}>${out}</svg>`;
}
