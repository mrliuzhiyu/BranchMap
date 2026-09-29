// 小部件：成员配色、一件工作的进度轨道。
import { esc } from './util.js';

const SLOTS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];

/** 按提交数给人分配固定颜色（和提交图的 Model 同一套规则）。 */
export function colorPersons(persons) {
  [...persons].sort((x, y) => (y.commits ?? 0) - (x.commits ?? 0)).forEach((p, i) => {
    p.color = SLOTS[i] ?? 'var(--other)';
  });
  return persons;
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
