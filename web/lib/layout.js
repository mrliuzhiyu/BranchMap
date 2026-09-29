// 提交图的泳道排布。
// 输入：按显示顺序排好的节点（子在父前）、取父节点的函数，以及：
//   pin   固定泳道：main 的第一父链固定在 0 道，dev 在 1 道
//   rails 贯穿全图的「轨道」：Map<道号, { start: 从哪一行开始, key: 归属 }>，这些道从开始那行一直画到底，别的分支不会占用
//   keyOf 每个节点属于谁（'main' / 'dev' / 'b:<分支>' / 'hist' / 'wip'），决定颜色
// 输出：每行节点所在泳道、归属，以及这一行要画的线段 [x1, y1, x2, y2, 归属]（x 是泳道号，y 取 0 / 0.5 / 1）。
// 一条边的颜色：子节点在主线上时取父节点的归属（比如合并进来的分支），否则取子节点的归属。

export const TRUNKS = new Set(['main', 'dev']);

export function layout(order, parentsOf, { pin = new Map(), rails = new Map(), keyOf }) {
  const rowOf = new Map();
  order.forEach((id, r) => rowOf.set(id, r));
  const lanes = [];
  const railLanes = new Set(rails.keys());
  const alloc = () => {
    for (let k = 0; ; k++) if (!lanes[k] && !railLanes.has(k)) return k;
  };
  const edgeKey = (child, parent) => (TRUNKS.has(keyOf(child)) ? keyOf(parent) : keyOf(child));
  const rows = new Array(order.length);
  let width = Math.max(1, ...[...railLanes].map((l) => l + 1));
  const straight = (segs, l) => segs.some((x) => x[0] === l && x[2] === l && x[1] === 0);

  for (let r = 0; r < order.length; r++) {
    const id = order[r];
    const segs = [];
    const hits = [];
    for (let j = 0; j < lanes.length; j++) if (lanes[j] && lanes[j].id === id) hits.push(j);

    let L;
    const pl = pin.get(id);
    if (pl !== undefined && (!lanes[pl] || lanes[pl].id === id)) L = pl;
    else if (hits.length) L = hits[0];
    else L = alloc();

    // 上半行：经过的线直下；指向本节点的线汇进来
    for (let j = 0; j < lanes.length; j++) {
      const ln = lanes[j];
      if (!ln) continue;
      if (ln.id === id) segs.push([j, 0, L, 0.5, ln.key]);
      else segs.push([j, 0, j, 1, ln.key]);
    }
    for (const j of hits) lanes[j] = null;

    // 下半行：第一父沿本道继续；其余父（合并进来的）连到已在等它的道，没有就新开一道
    const ps = parentsOf(id).filter((p) => rowOf.has(p));
    if (ps.length) {
      const k0 = edgeKey(id, ps[0]);
      lanes[L] = { id: ps[0], key: k0 };
      segs.push([L, 0.5, L, 1, k0]);
      for (let i = 1; i < ps.length; i++) {
        let k = lanes.findIndex((x) => x && x.id === ps[i]);
        const key = edgeKey(id, ps[i]);
        if (k < 0) {
          k = alloc();
          lanes[k] = { id: ps[i], key };
        }
        segs.push([L, 0.5, k, 1, key]);
      }
    }
    // 轨道：从开始那行往下一直画，哪怕这一段没有它的提交
    for (const [l, { start, key }] of rails) {
      if (r < start) continue;
      if (r === start) {
        if (L !== l) segs.push([l, 0.5, l, 1, key]);
      } else if (!straight(segs, l)) segs.push([l, 0, l, 1, key]);
    }
    while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();
    width = Math.max(width, L + 1, lanes.length);
    rows[r] = { lane: L, key: keyOf(id), segs };
  }
  return { rows, width };
}

/** 一条线段的 SVG 路径（x 已换成像素）。换道的线画成两端竖直的 S 形。 */
export function segPath(x1, y1, x2, y2) {
  if (x1 === x2) return `M${x1} ${y1}V${y2}`;
  const ym = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`;
}
