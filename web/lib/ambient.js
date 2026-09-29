// 全站背景（参照 OriginSpace）：两块铺满窗口、在内容底下、不挡点击的画布。
//   浮形 —— 圆 / 方 / 三角的描边从下往上慢慢飘，颜色很淡，只是氛围
//   流星 —— 偶尔一颗从右上划到左下（平均 6~10 秒一颗，最多同时 2 颗），4% 概率是彩虹色的彩蛋
// 节能：系统开了「减少动态效果」就不启动；切到别的标签页暂停；像素比最高按 2 算；窗口改大小时防抖。

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const dark = () => document.documentElement.dataset.theme === 'dark';

function canvas(id) {
  const c = document.createElement('canvas');
  c.id = id;
  c.className = 'ambient';
  c.setAttribute('aria-hidden', 'true');
  document.body.prepend(c);
  return c;
}

function runner(c, setup, draw) {
  const ctx = c.getContext('2d', { alpha: true });
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const size = { W: 0, H: 0 };
  let raf = 0;
  let timer = 0;
  const resize = () => {
    size.W = innerWidth;
    size.H = innerHeight;
    c.width = size.W * dpr;
    c.height = size.H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    setup(size);
  };
  const frame = (now) => {
    ctx.clearRect(0, 0, size.W, size.H);
    draw(ctx, size, now);
    raf = requestAnimationFrame(frame);
  };
  const start = () => {
    if (!raf) raf = requestAnimationFrame(frame);
  };
  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };
  resize();
  start();
  addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(resize, 120);
  });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
}

/* ---------- 浮形 ---------- */
function shapes() {
  const kinds = ['circle', 'square', 'triangle'];
  let list = [];
  const spawn = (W, H, y) => ({
    x: Math.random() * W,
    y: y ?? Math.random() * H,
    size: 10 + Math.random() * 26,
    vy: -(0.08 + Math.random() * 0.2),
    phase: Math.random() * Math.PI * 2,
    amp: 4 + Math.random() * 10,
    rot: Math.random() * Math.PI * 2,
    vrot: (Math.random() - 0.5) * 0.005,
    kind: kinds[Math.floor(Math.random() * 3)],
    alpha: 0.05 + Math.random() * 0.05,
  });
  let t = 0;
  runner(canvas('bm-shapes'), ({ W, H }) => {
    const n = W < 640 ? 15 : 30;
    if (!list.length) list = Array.from({ length: n }, () => spawn(W, H));
    while (list.length < n) list.push(spawn(W, H));
    list.length = n;
  }, (ctx, { W, H }) => {
    t++;
    const ink = dark() ? '255, 255, 255' : '0, 0, 0';
    ctx.lineWidth = 1.5;
    for (const s of list) {
      s.y += s.vy;
      s.x += Math.sin((t + s.phase * 60) * 0.01) * (s.amp / 200);
      s.rot += s.vrot;
      if (s.y + s.size < 0) {
        s.y = H + s.size + Math.random() * 40;
        s.x = Math.random() * W;
      }
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot);
      ctx.strokeStyle = `rgba(${ink}, ${dark() ? s.alpha * 0.8 : s.alpha})`;
      const h = s.size / 2;
      ctx.beginPath();
      if (s.kind === 'circle') ctx.arc(0, 0, h, 0, Math.PI * 2);
      else if (s.kind === 'square') ctx.rect(-h, -h, s.size, s.size);
      else {
        ctx.moveTo(0, -h);
        ctx.lineTo(h, h);
        ctx.lineTo(-h, h);
        ctx.closePath();
      }
      ctx.stroke();
      ctx.restore();
    }
  });
}

/* ---------- 流星 ---------- */
function meteors() {
  const A = (135 * Math.PI) / 180; // 右上 → 左下
  const UX = Math.cos(A);
  const UY = Math.sin(A);
  let list = [];
  let nextAt = performance.now() + 1500 + Math.random() * 1000;
  runner(canvas('bm-meteors'), () => {}, (ctx, { W, H }, now) => {
    if (now >= nextAt) {
      if (list.length >= 2) nextAt = now + 1200;
      else {
        const rainbow = Math.random() < 0.04;
        const big = rainbow || Math.random() < 0.2;
        list.push({
          x0: W * 0.3 + Math.random() * W * 0.8,
          y0: -200 + Math.random() * (H * 0.35 + 200),
          span: Math.hypot(W, H) + 600,
          tail: big ? 240 + Math.random() * 50 : 150 + Math.random() * 60,
          size: big ? 2.4 + Math.random() * 0.5 : 1.8 + Math.random() * 0.5,
          t0: now,
          dur: big ? 14000 : 11000,
          big,
          rainbow,
        });
        nextAt = now + (rainbow ? 9500 : big ? 7500 : 6500) + Math.random() * 4000;
      }
    }
    const alive = [];
    for (const m of list) {
      const t = (now - m.t0) / m.dur;
      if (t >= 1) continue;
      const d = m.span * (1 - Math.pow(1 - t, 3));
      const hx = m.x0 + UX * d;
      const hy = m.y0 + UY * d;
      const e = t < 0.12 ? t / 0.12 : t > 0.85 ? (1 - t) / 0.15 : 1;
      const tx = hx - UX * m.tail;
      const ty = hy - UY * m.tail;
      const g = ctx.createLinearGradient(hx, hy, tx, ty);
      if (m.rainbow) {
        g.addColorStop(0, `rgba(239,68,68,${0.95 * e})`);
        g.addColorStop(0.2, `rgba(249,115,22,${0.8 * e})`);
        g.addColorStop(0.4, `rgba(234,179,8,${0.65 * e})`);
        g.addColorStop(0.6, `rgba(34,197,94,${0.5 * e})`);
        g.addColorStop(0.8, `rgba(59,130,246,${0.35 * e})`);
        g.addColorStop(1, 'rgba(168,85,247,0)');
      } else {
        g.addColorStop(0, `rgba(37,99,235,${0.9 * e})`);
        g.addColorStop(0.4, `rgba(96,165,250,${0.55 * e})`);
        g.addColorStop(1, 'rgba(125,211,252,0)');
      }
      ctx.strokeStyle = g;
      ctx.lineWidth = m.big ? 2.2 : 1.7;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.save();
      ctx.shadowColor = m.rainbow ? `rgba(236,72,153,${0.95 * e})` : `rgba(125,211,252,${0.95 * e})`;
      ctx.shadowBlur = m.rainbow ? 28 : m.big ? 22 : 16;
      ctx.fillStyle = m.rainbow ? `rgba(239,68,68,${e})` : `rgba(37,99,235,${e})`;
      ctx.beginPath();
      ctx.arc(hx, hy, m.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      alive.push(m);
    }
    list = alive;
  });
}

export function startAmbient() {
  if (reduced || document.getElementById('bm-shapes')) return;
  shapes();
  meteors();
}
