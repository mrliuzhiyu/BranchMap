// 流水线相关的小部件：站的图标和颜色、进度轨道、首页的迷你流水线、成员配色。
// 颜色和提交图一致：main 蓝（第 1 道）、dev 橙（第 2 道）。
import { esc, icon, ago, span, nowSec } from './util.js';

const SLOTS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];

/** 按提交数给人分配固定颜色（和提交图的 Model 同一套规则）。 */
export function colorPersons(persons) {
  [...persons].sort((x, y) => (y.commits ?? 0) - (x.commits ?? 0)).forEach((p, i) => {
    p.color = SLOTS[i] ?? 'var(--other)';
  });
  return persons;
}

/** 主线分支的颜色：最后一条（上线用的）蓝，第一条（集成用的）橙，中间的绿。 */
export function stageColor(stages, s) {
  if (s.kind !== 'branch') return null;
  const branches = stages.filter((x) => x.kind === 'branch');
  const i = branches.findIndex((x) => x.key === s.key);
  if (i === branches.length - 1) return 'var(--s1)';
  if (i === 0) return 'var(--s2)';
  return 'var(--s3)';
}

export function stageIcon(s, size = 14) {
  if (s.kind === 'branch') return icon.branch(size);
  if (s.envKind === 'channel') return icon.package(size);
  if (s.envKind === 'local') return icon.desktop(size);
  return icon.server(size);
}

/** 环境状态的文字（永远和颜色一起出现）。 */
export function envStateLabel(s) {
  const r = s.result ?? {};
  if (r.state === 'unconfigured') return '未配置探测';
  if (r.state === 'pending') return '探测中…';
  if (r.state === 'down') return s.envKind === 'local' ? '没在运行' : '连不上';
  if (s.foreign) return '版本不在云端';
  if (!s.known) return r.version ? '提交未知' : '版本未知';
  return '在线';
}
export function envLed(s) {
  const r = s.result ?? {};
  if (r.state === 'down') return s.envKind === 'local' ? 'unknown' : 'down';
  if (r.state === 'up' && s.known) return 'up';
  if (r.state === 'up') return 'unknown';
  return r.state ?? 'unknown';
}

/**
 * 一件工作的进度轨道：起点 + 每一站一个点。
 * counts[i]：这件工作有几个提交已经到了第 i 站（null = 这站读不出版本）；total：一共几个提交。
 */
export function track(stages, counts, total, { lg = false } = {}) {
  let html = `<span class="track${lg ? ' lg' : ''}" data-tip-html="1" data-tip="${esc(trackTip(stages, counts, total))}"><i class="td start"></i>`;
  stages.forEach((s, i) => {
    const n = counts[i];
    const st = n == null ? 'unk' : n >= total ? 'full' : n > 0 ? 'part' : 'none';
    html += `<b class="tl${st === 'full' || st === 'part' ? ' on' : ''}"></b><i class="td ${st}"></i>`;
  });
  return html + '</span>';
}
function trackTip(stages, counts, total) {
  return stages.map((s, i) => {
    const n = counts[i];
    const v = n == null ? '读不出版本' : n >= total ? '✓ 全部已到' : n > 0 ? `${n} / ${total} 个已到` : '还没到';
    return `<div class="tr"><span style="min-width:64px">${esc(s.name)}</span><span class="tl">${esc(v)}</span></div>`;
  }).join('');
}

export function trackLegend() {
  return `<span class="track-legend"><span><span class="track"><i class="td full"></i></span>已到</span><span><span class="track"><i class="td part"></i></span>部分</span><span><span class="track"><i class="td none"></i></span>未到</span><span><span class="track"><i class="td unk"></i></span>读不出</span></span>`;
}

/** 首页一行里的迷你流水线：dev ─3→ 测试 ─0→ main … */
export function miniFlow(p) {
  if (!p.stages?.length) return '<span class="muted" style="font-size:12px">没有识别出 dev / main 这样的主线分支</span>';
  const parts = [];
  p.stages.forEach((s, i) => {
    if (i > 0) {
      const g = p.gaps[i - 1];
      const prev = p.stages[g.from ?? i - 1];
      if (g.pending == null) parts.push(`<span class="mg" data-tip="读不出版本，没法比较">┄?┄</span>`);
      else if (g.reverse) parts.push(`<span class="mg rev" data-tip="${esc(`${s.name} 有 ${g.reverse} 个提交是 ${prev.name} 没有的`)}">${icon.alert(11)}${g.pending ? g.pending : ''}→</span>`);
      else parts.push(`<span class="mg${g.pending ? ' has' : ''}" data-tip="${esc(g.pending ? `${g.pending} 个提交在 ${prev.name}、还没到 ${s.name}` : `${s.name} 已包含 ${prev.name} 的全部提交`)}">${g.pending ? g.pending + ' →' : '→'}</span>`);
    }
    if (s.kind === 'branch') {
      const color = stageColor(p.stages, s);
      parts.push(`<span class="ms" style="--st:${color}" data-tip="${esc(`分支 ${s.name} · ${s.short ?? ''}`)}"><i class="bar"></i>${esc(s.name)}</span>`);
    } else {
      const led = s.state === 'up' && s.known ? 'up' : s.state === 'down' ? 'down' : 'unknown';
      const tip = s.state === 'down' ? '连不上' : !s.known ? (s.version ? `版本 ${s.version}，提交未知` : s.state === 'unconfigured' ? '未配置探测' : '读不出运行的版本') : `运行 ${s.short}${s.version ? ' · 版本 ' + s.version : ''}`;
      parts.push(`<span class="ms env" data-tip="${esc(s.name + '：' + tip)}"><i class="led ${led}"></i>${esc(s.name)}</span>`);
    }
  });
  return `<div class="mini">${parts.join('')}</div>`;
}

/** 「等了多久」：从最早一个待推进的提交算起。 */
export function waited(t) {
  return t ? span(nowSec() - t) : '';
}
export { ago };
