// 颜色跟着「东西」走，任何页面都一样：main 蓝、dev 橙、每条分支按名字固定一种颜色（12 种里选）。
export const MAIN = 'var(--s1)';
export const DEV = 'var(--s2)';
export const HIST = 'var(--hist)';
const PALETTE = Array.from({ length: 12 }, (_, i) => `var(--b${i})`); // 12 种分支色（style.css 里的 --b0…--b11）

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** 分支的颜色；trunk = { main, dev } 分支名。 */
export function branchColor(name, trunk = {}) {
  if (name && name === trunk.main) return MAIN;
  if (name && name === trunk.dev) return DEV;
  return PALETTE[hash(name ?? '') % PALETTE.length];
}
