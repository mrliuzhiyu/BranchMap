// 上下拖动排序（侧栏项目列表用）。按住一项往上 / 下拖：它浮起来跟着鼠标，其余的项平滑地让出位置；
// 松手落到空位上。列表里可以夹着分组标题（[data-grp]），拖过标题就换到那一组。
// 只管交互，不管数据：松手后把新的顺序交给 onDrop，由调用方决定存到哪。
//
//   sortable(container, { item: '[data-pj]', ignore: 'button', scroller: () => 滚动的那个元素, onDrop: (order) => … })
//   order = [{ id, group }]：id 是项的 data-pj，group 是它落在哪个分组标题下（没有标题时为 undefined）
let dragging = false;
let suppressUntil = 0;
/** 正在拖：这时候别重画列表，否则拖着的东西会被换掉。 */
export const isDragging = () => dragging;

const THRESHOLD = 5;
const EDGE = 36;

export function sortable(container, { item, ignore = null, onDrop, scroller = () => container }) {
  let st = null; // { el, ph, startY, offY, dragging, pid, raf, lastY }

  const items = () => [...container.querySelectorAll(item)];
  const idOf = (el) => el.dataset.pj ?? el.dataset.id;

  container.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || dragging) return;
    const el = e.target.closest(item);
    if (!el || !container.contains(el) || (ignore && e.target.closest(ignore))) return;
    st = { el, startY: e.clientY, startX: e.clientX, pid: e.pointerId, dragging: false, lastY: e.clientY };
  });

  window.addEventListener('pointermove', (e) => {
    if (!st || e.pointerId !== st.pid) return;
    st.lastY = e.clientY;
    if (!st.dragging) {
      if (Math.abs(e.clientY - st.startY) < THRESHOLD) return;
      start();
    }
    e.preventDefault();
    move(e.clientY);
  });
  window.addEventListener('pointerup', (e) => {
    if (!st || e.pointerId !== st.pid) return;
    if (st.dragging) finish(true);
    else st = null;
  });
  window.addEventListener('pointercancel', () => st?.dragging ? finish(false) : (st = null));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && st?.dragging) finish(false);
  });
  // 链接自带的原生拖拽（拖出一个网址）会抢走指针，关掉
  container.addEventListener('dragstart', (e) => e.target.closest?.(item) && e.preventDefault());
  // 拖完松手时浏览器还会补一个 click：吞掉，别当成点了链接
  window.addEventListener('click', (e) => {
    if (Date.now() < suppressUntil) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  function start() {
    dragging = true;
    st.dragging = true;
    const el = st.el;
    const r = el.getBoundingClientRect();
    st.offY = st.startY - r.top;
    st.before = items().map(idOf).join('|');
    st.home = { parent: el.parentNode, next: el.nextSibling };
    // 空位：和被拖的项一样高，留在原处
    const ph = document.createElement('div');
    ph.className = 'sort-ph';
    ph.style.height = r.height + 'px';
    el.parentNode.insertBefore(ph, el);
    st.ph = ph;
    // 被拖的项浮起来（固定定位，宽度不变）
    el.classList.add('sort-lift');
    Object.assign(el.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', zIndex: 80 });
    document.body.append(el);
    document.documentElement.classList.add('sorting');
    autoScroll();
  }

  /** 空位该在哪：鼠标所在的高度对应的那个兄弟前面。 */
  function move(y) {
    st.el.style.top = y - st.offY + 'px';
    const sibs = [...st.ph.parentNode.children].filter((x) => x !== st.ph && (x.matches(item) || x.matches('[data-grp]')));
    let target = null;
    for (const s of sibs) {
      const r = s.getBoundingClientRect();
      if (y < r.top + r.height / 2) {
        target = s;
        break;
      }
    }
    // 有分组时，空位不能跑到第一个分组标题上面
    const firstGrp = sibs.find((x) => x.matches('[data-grp]'));
    if (firstGrp && target && sibs.indexOf(target) <= sibs.indexOf(firstGrp)) target = firstGrp.nextElementSibling;
    const cur = st.ph.nextElementSibling;
    if (target === cur || (target === null && !sibs.includes(cur))) return;
    flip(sibs, () => {
      if (target) target.parentNode.insertBefore(st.ph, target);
      else {
        const last = sibs.at(-1);
        last ? last.after(st.ph) : st.ph.parentNode.append(st.ph);
      }
    });
  }

  /** FLIP：先记下位置，改 DOM，再从旧位置平滑过渡到新位置。 */
  function flip(els, change) {
    const before = new Map(els.map((x) => [x, x.getBoundingClientRect().top]));
    change();
    for (const x of els) {
      const d = before.get(x) - x.getBoundingClientRect().top;
      if (!d) continue;
      x.style.transition = 'none';
      x.style.transform = `translateY(${d}px)`;
      requestAnimationFrame(() => {
        x.style.transition = 'transform .16s ease';
        x.style.transform = '';
      });
    }
  }

  /** 拖到列表上下边缘时自动滚动。 */
  function autoScroll() {
    if (!st?.dragging) return;
    const sc = scroller();
    if (!sc) return;
    const r = sc.getBoundingClientRect();
    const y = st.lastY;
    const v = y < r.top + EDGE ? -Math.ceil((r.top + EDGE - y) / 4) : y > r.bottom - EDGE ? Math.ceil((y - r.bottom + EDGE) / 4) : 0;
    if (v) {
      sc.scrollTop += v;
      move(y);
    }
    st.raf = requestAnimationFrame(autoScroll);
  }

  function finish(commit) {
    const { el, ph, home } = st;
    cancelAnimationFrame(st.raf);
    if (commit) ph.replaceWith(el);
    else {
      ph.remove();
      home.parent.insertBefore(el, home.next);
    }
    el.classList.remove('sort-lift');
    el.style.cssText = '';
    document.documentElement.classList.remove('sorting');
    suppressUntil = Date.now() + 400;
    const before = st.before;
    st = null;
    dragging = false;
    if (!commit) return;
    // 每一项落在哪个分组标题下面
    const order = [];
    let group;
    for (const x of container.querySelectorAll(`${item}, [data-grp]`)) {
      if (x.matches('[data-grp]')) group = x.dataset.grp;
      else order.push({ id: idOf(x), group });
    }
    const g = order.find((x) => x.id === idOf(el))?.group;
    const moved = order.map((x) => x.id).join('|') !== before || (g !== undefined && (g || '') !== (el.dataset.group || ''));
    // 等浏览器补的那个 click 过去了再交出去（调用方多半要重画列表）
    if (moved) setTimeout(() => onDrop?.(order), 0);
  }
}
