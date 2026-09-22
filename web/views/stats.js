// 统计：一行筛选（范围 + 时间）作用于下面所有图表；提交热力图、按人的每周提交、增删行、累计行数、提交时间分布、贡献者、热点文件。
import { esc, icon, avatar, who, ago, stamp, day, num, compact, lineStat, DAY, nowSec, dayStart, weekStart } from '../lib/util.js';
import { columns, mirrored, area, calendar, punchcard, scaleLegend } from '../lib/charts.js';

const RANGES = [
  { id: '30', label: '近 30 天', days: 30 },
  { id: '90', label: '近 90 天', days: 90 },
  { id: '365', label: '近 1 年', days: 365 },
  { id: 'all', label: '全部', days: Infinity },
];

export function mount(el, ctx) {
  const { model: M, store } = ctx;
  let ref = ctx.params.get('ref') || '';
  let range = ctx.params.get('range') || '90';
  let data = null;
  let token = 0;

  const refOptions = [['', '全部分支'], ...[M.trunk.prod, M.trunk.dev, M.head].filter((x, i, a) => x && a.indexOf(x) === i).map((n) => [n, n])];
  el.innerHTML = `<div class="page"><div class="page-narrow">
    <div class="row" style="gap:12px;margin-bottom:16px;flex-wrap:wrap">
      <select class="select" data-refsel>${refOptions.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>
      <div class="seg" data-ranges>${RANGES.map((r) => `<button data-range="${r.id}">${r.label}</button>`).join('')}</div>
      <span class="muted" style="font-size:12px">不含合并提交 · 头像颜色按总提交数固定分给前 8 位，其余为「其他」</span>
    </div>
    <div data-body><div class="loading">正在统计全部提交的增删行（第一次会慢一点）…</div></div>
  </div></div>`;
  const bodyEl = el.querySelector('[data-body]');
  const sel = el.querySelector('[data-refsel]');
  sel.value = ref;
  if (sel.value !== ref) { ref = ''; sel.value = ''; }

  function syncControls() {
    el.querySelectorAll('[data-range]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === range)));
  }
  async function load() {
    const my = ++token;
    syncControls();
    if (data) bodyEl.style.opacity = '0.5';
    try {
      const d = await store.stats(ref || null);
      if (my !== token) return;
      data = d;
      bodyEl.style.opacity = '';
      draw();
    } catch (e) {
      if (my === token) bodyEl.innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
    }
  }

  function draw() {
    const R = RANGES.find((r) => r.id === range) ?? RANGES[1];
    const now = nowSec();
    const C = data.commits;
    const from = R.days === Infinity ? 0 : dayStart(now) - (R.days - 1) * DAY;
    const idx = [];
    for (let i = 0; i < C.t.length; i++) if (C.t[i] >= from) idx.push(i);
    if (!idx.length) {
      bodyEl.innerHTML = `<div class="empty">${esc(R.label)}没有提交</div>`;
      return;
    }
    const first = Math.min(...idx.map((i) => C.t[i]));
    const span = (now - (R.days === Infinity ? first : from)) / DAY;
    const unit = span <= 45 ? 'day' : span <= 600 ? 'week' : 'month';
    const bucketOf = (t) => {
      if (unit === 'day') return dayStart(t);
      if (unit === 'week') return weekStart(t);
      const d = new Date(t * 1000);
      return new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000;
    };
    const next = (t) => {
      const d = new Date(t * 1000);
      if (unit === 'day') d.setDate(d.getDate() + 1);
      else if (unit === 'week') d.setDate(d.getDate() + 7);
      else d.setMonth(d.getMonth() + 1);
      return d.getTime() / 1000;
    };
    const buckets = [];
    for (let t = bucketOf(R.days === Infinity ? first : from); t <= now; t = next(t)) buckets.push(t);
    const bi = new Map(buckets.map((t, i) => [t, i]));
    const fmt = (t) => {
      const d = new Date(t * 1000);
      return unit === 'month' ? `${String(d.getFullYear()).slice(2)}年${d.getMonth() + 1}月` : `${d.getMonth() + 1}/${d.getDate()}`;
    };
    const tipTitle = (i) => (unit === 'day' ? day(buckets[i]) : unit === 'week' ? `${day(buckets[i])} 这一周` : fmt(buckets[i]));

    // 汇总
    const people = new Map();
    const days = new Set();
    let add = 0;
    let del = 0;
    const perBucketPerson = new Map();
    const adds = new Array(buckets.length).fill(0);
    const dels = new Array(buckets.length).fill(0);
    const punch = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const i of idx) {
      const t = C.t[i];
      const a = C.a[i];
      add += C.add[i];
      del += C.del[i];
      days.add(dayStart(t));
      let p = people.get(a);
      if (!p) people.set(a, (p = { id: a, n: 0, add: 0, del: 0, days: new Set(), first: t, last: t }));
      p.n++;
      p.add += C.add[i];
      p.del += C.del[i];
      p.days.add(dayStart(t));
      p.first = Math.min(p.first, t);
      p.last = Math.max(p.last, t);
      const b = bi.get(bucketOf(t));
      if (b !== undefined) {
        adds[b] += C.add[i];
        dels[b] += C.del[i];
        const person = M.person(a);
        const key = person && person.rank < 8 ? a : 'other';
        if (!perBucketPerson.has(key)) perBucketPerson.set(key, new Array(buckets.length).fill(0));
        perBucketPerson.get(key)[b]++;
      }
      const d = new Date(t * 1000);
      punch[(d.getDay() + 6) % 7][d.getHours()]++;
    }
    const series = [...perBucketPerson.entries()]
      .sort((x, y) => (x[0] === 'other' ? 1 : y[0] === 'other' ? -1 : M.person(x[0]).rank - M.person(y[0]).rank))
      .map(([k, values]) => ({ name: k === 'other' ? '其他' : M.person(k).name, color: k === 'other' ? 'var(--other)' : M.person(k).color, values }));

    // 累计净行数（按时间顺序，从这个范围开始前的累计值起算）
    const order = [...Array(C.t.length).keys()].sort((x, y) => C.t[x] - C.t[y]);
    const cum = new Array(buckets.length).fill(null);
    let running = 0;
    let before = 0; // 范围开始前已经累计的
    for (const i of order) {
      running += C.add[i] - C.del[i];
      const b = bi.get(bucketOf(C.t[i]));
      if (b !== undefined) cum[b] = running;
      else if (C.t[i] < buckets[0]) before = running;
    }
    for (let b = 0, last = before; b < cum.length; b++) {
      if (cum[b] == null) cum[b] = last;
      last = cum[b];
    }

    const cal = new Map();
    for (let i = 0; i < C.t.length; i++) {
      const d = dayStart(C.t[i]);
      cal.set(d, (cal.get(d) ?? 0) + 1);
    }

    const contributors = [...people.values()].sort((x, y) => y.n - x.n);
    const maxN = contributors[0]?.n ?? 1;
    const unitLabel = { day: '天', week: '周', month: '月' }[unit];
    const legend = series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('');

    bodyEl.innerHTML = `<div class="grid" style="gap:16px">
      <div class="tiles">
        <div class="tile"><div class="k">提交</div><div class="v">${num(idx.length)}</div><div class="d">${esc(R.label)} · 不含合并</div></div>
        <div class="tile"><div class="k">参与的人</div><div class="v">${people.size}</div><div class="d">有提交的成员</div></div>
        <div class="tile"><div class="k">新增行</div><div class="v">${compact(add)}</div><div class="d">${num(add)} 行</div></div>
        <div class="tile"><div class="k">删除行</div><div class="v">${compact(del)}</div><div class="d">${num(del)} 行</div></div>
        <div class="tile"><div class="k">活跃天数</div><div class="v">${days.size}</div><div class="d">有提交的日子</div></div>
      </div>
      <section class="block"><div class="block-h"><h2>提交热力图</h2><span class="sub">最近一年，每格一天${ref ? ' · ' + esc(ref) : ''}</span><div class="actions">${scaleLegend()}</div></div><div class="block-b"><div class="chart" data-cal></div></div></section>
      <section class="block"><div class="block-h"><h2>每${unitLabel}提交 · 按人</h2><span class="sub">${esc(R.label)}</span></div><div class="block-b"><div class="legend">${legend}</div><div class="chart" data-cols></div></div></section>
      <div class="grid g2">
        <section class="block"><div class="block-h"><h2>每${unitLabel}增删行</h2><span class="sub">上方新增、下方删除</span></div><div class="block-b"><div class="legend"><span><i style="background:var(--s1)"></i>新增</span><span><i style="background:var(--s8)"></i>删除</span></div><div class="chart" data-mirror></div></div></section>
        <section class="block"><div class="block-h"><h2>累计净增行数</h2><span class="sub">新增 − 删除，从第一个提交起累加${ref ? '（' + esc(ref) + ' 的历史）' : '（所有分支，同一提交只算一次）'}</span></div><div class="block-b"><div class="chart" data-area></div></div></section>
      </div>
      <div class="grid g2">
        <section class="block"><div class="block-h"><h2>贡献者</h2><span class="sub">${esc(R.label)}</span></div>
          <div style="overflow:auto"><table class="tbl"><thead><tr><th>成员</th><th>提交</th><th class="num">新增</th><th class="num">删除</th><th class="num">活跃天</th><th class="num">最近</th></tr></thead><tbody>${contributors.map((p) => {
            const person = M.person(p.id);
            return `<tr class="click" data-person="${p.id}"><td>${who(person, 20)}</td><td style="min-width:150px"><div class="hbar" style="grid-template-columns:minmax(0,1fr) 48px"><span class="track" style="width:${(p.n / maxN) * 100}%;background:${person?.color ?? 'var(--other)'}"></span><span class="num">${num(p.n)}</span></div></td><td class="num"><span class="lines"><span class="a">+${compact(p.add)}</span></span></td><td class="num"><span class="lines"><span class="d">−${compact(p.del)}</span></span></td><td class="num">${p.days.size}</td><td class="num muted">${ago(p.last)}</td></tr>`;
          }).join('')}</tbody></table></div></section>
        <section class="block"><div class="block-h"><h2>提交时间分布</h2><span class="sub">${esc(R.label)} · 星期 × 小时（本机时区）</span><div class="actions">${scaleLegend()}</div></div><div class="block-b"><div class="chart" data-punch></div></div></section>
      </div>
      <section class="block"><div class="block-h"><h2>改得最多的文件</h2><span class="sub">${ref ? esc(ref) + ' 的' : ''}全部历史 · 按被改的次数</span></div>
        <div style="overflow:auto;max-height:560px"><table class="tbl"><thead><tr><th>文件</th><th>被改次数</th><th class="num">新增</th><th class="num">删除</th><th>主要改动人</th><th class="num">最近</th></tr></thead><tbody>${data.files.slice(0, 40).map((f) => `<tr class="click" data-file="${esc(f.p)}"><td class="mono ell" style="font-size:12px;max-width:520px" title="${esc(f.p)}">${esc(f.p)}</td><td style="min-width:140px"><div class="hbar" style="grid-template-columns:minmax(0,1fr) 40px"><span class="track" style="width:${(f.n / data.files[0].n) * 100}%"></span><span class="num">${f.n}</span></div></td><td class="num"><span class="lines"><span class="a">+${compact(f.add)}</span></span></td><td class="num"><span class="lines"><span class="d">−${compact(f.del)}</span></span></td><td><span class="avs">${f.by.map(([a, n]) => avatar(M.person(a), 20, `${n} 次`)).join('')}</span></td><td class="num muted">${ago(f.last)}</td></tr>`).join('')}</tbody></table></div></section>
    </div>`;
    calendar(bodyEl.querySelector('[data-cal]'), { counts: cal, end: now });
    columns(bodyEl.querySelector('[data-cols]'), { labels: buckets, series, height: 220, xFmt: fmt, tipTitle, unit: ' 个' });
    mirrored(bodyEl.querySelector('[data-mirror]'), { labels: buckets, up: { name: '新增行', color: 'var(--s1)', values: adds }, down: { name: '删除行', color: 'var(--s8)', values: dels }, height: 220, xFmt: fmt, tipTitle });
    area(bodyEl.querySelector('[data-area]'), { labels: buckets, values: cum, name: '累计净增行数', height: 220, xFmt: fmt, tipTitle });
    punchcard(bodyEl.querySelector('[data-punch]'), { grid: punch });
  }

  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-range],[data-person],[data-file]');
    if (!t) return;
    if (t.dataset.range) { range = t.dataset.range; ctx.setParams({ range }); syncControls(); draw(); }
    else if (t.dataset.person) location.hash = ctx.href('people', { p: t.dataset.person }).slice(1);
    else if (t.dataset.file) location.hash = ctx.href('files', { ref: ref || M.head || M.trunk.dev || M.trunk.prod, path: t.dataset.file, v: 'history' }).slice(1);
  });
  sel.addEventListener('change', () => { ref = sel.value; ctx.setParams({ ref }); load(); });

  syncControls();
  load();
  return {
    theme() { if (data) draw(); },
  };
}
