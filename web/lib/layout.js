// 提交图的泳道排布。
// 输入：按显示顺序排好的节点（子在父前）、取父节点的函数、固定泳道（main 的第一父链固定在 0 道，dev 在 1 道）。
// 输出：每行节点所在泳道、颜色，以及这一行里要画的线段 [x1, y1, x2, y2, 颜色]（x 是泳道号，y 取 0 / 0.5 / 1 表示行顶 / 行中 / 行底）。
// 颜色号：0 = main，1 = dev，2..7 其他分支轮换，-1 = 未提交的改动（虚线）。

export const WIP_COLOR = -1;

export function layout(order, parentsOf, pin = new Map(), pinColor = new Map(), isWip = () => false) {
  const rowOf = new Map();
  order.forEach((id, r) => rowOf.set(id, r));
  const lanes = [];
  const remaining = new Map();
  for (const [id, l] of pin) if (rowOf.has(id)) remaining.set(l, (remaining.get(l) ?? 0) + 1);
  const reserved = new Set([...remaining.keys()]);
  let rot = 0;
  const nextColor = () => 2 + (rot++ % 6);
  const alloc = () => {
    for (let k = 0; ; k++) if (!lanes[k] && !reserved.has(k)) return k;
  };
  const rows = new Array(order.length);
  let width = 1;

  for (let r = 0; r < order.length; r++) {
    const id = order[r];
    const segs = [];
    const hits = [];
    for (let j = 0; j < lanes.length; j++) if (lanes[j] && lanes[j].id === id) hits.push(j);

    let L;
    let color;
    const pl = pin.get(id);
    if (pl !== undefined && (!lanes[pl] || lanes[pl].id === id)) {
      L = pl;
      color = pinColor.get(pl) ?? 0;
    } else if (hits.length) {
      L = hits[0];
      color = lanes[L].color;
    } else {
      L = alloc();
      color = isWip(id) ? WIP_COLOR : nextColor();
    }

    // 上半行：经过的线直下；指向本节点的线汇进来
    for (let j = 0; j < lanes.length; j++) {
      const ln = lanes[j];
      if (!ln) continue;
      if (ln.id === id) segs.push([j, 0, L, 0.5, ln.color]);
      else segs.push([j, 0, j, 1, ln.color]);
    }
    for (const j of hits) lanes[j] = null;
    if (pl !== undefined && L === pl) {
      const left = remaining.get(pl) - 1;
      remaining.set(pl, left);
      if (left <= 0) reserved.delete(pl);
    }

    // 下半行：第一父沿本道继续；其余父（合并进来的）连到已在等它的道，没有就新开一道
    const ps = parentsOf(id).filter((p) => rowOf.has(p));
    if (ps.length) {
      const nodeColor = color === WIP_COLOR ? WIP_COLOR : color;
      lanes[L] = { id: ps[0], color: nodeColor };
      segs.push([L, 0.5, L, 1, nodeColor]);
      for (let i = 1; i < ps.length; i++) {
        let k = lanes.findIndex((x) => x && x.id === ps[i]);
        if (k < 0) {
          k = alloc();
          lanes[k] = { id: ps[i], color: nextColor() };
        }
        segs.push([L, 0.5, k, 1, lanes[k].color]);
      }
    }
    while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();
    width = Math.max(width, L + 1, lanes.length);
    rows[r] = { lane: L, color, segs };
  }
  return { rows, width };
}

/** 一条线段的 SVG 路径（x 已换成像素）。换道的线画成两端竖直的 S 形。 */
export function segPath(x1, y1, x2, y2) {
  if (x1 === x2) return `M${x1} ${y1}V${y2}`;
  const ym = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`;
}
