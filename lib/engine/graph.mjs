// 提交图：在内存里走提交关系，回答「这个提交在不在那条分支 / 那个环境里」。
// 输入是 Repo.graph() 的结果（提交按时间倒序，子提交一定排在父提交前面）。
// 可达集合用位图存，几千到几万个提交都是毫秒级。

function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
export const has = (set, i) => i >= 0 && ((set[i >>> 5] >>> (i & 31)) & 1) === 1;

export class CommitGraph {
  constructor(raw) {
    const C = raw.commits;
    this.raw = raw;
    this.N = C.h.length;
    this.W = (this.N + 31) >>> 5;
    this.h = C.h;
    this.P = C.p;
    this.a = C.a;
    this.t = C.t;
    this.ct = C.ct;
    this.s = C.s;
    this.index = new Map(C.h.map((x, i) => [x, i]));
    this.people = raw.people;
    this.ancCache = new Map();
    this.chainCache = new Map();

    this.branches = new Map(); // 云端分支名 -> 提交
    this.tags = new Map(); // 标签名 -> 提交
    for (const r of raw.refs) {
      if (r.k === 'R' && r.remote === 'origin') this.branches.set(r.short, r.c);
      else if (r.k === 'L' && !this.branches.has(r.n)) this.branches.set(r.n, r.c);
      else if (r.k === 'T') this.tags.set(r.n, r.c);
    }
    this.defaultBranch = raw.trunk?.prod ?? null;
    this.empty = new Uint32Array(this.W);
  }

  branchTip(name) {
    const c = this.branches.get(name);
    return c === undefined ? -1 : c;
  }
  resolve(sha) {
    if (!sha) return -1;
    const exact = this.index.get(sha);
    if (exact !== undefined) return exact;
    if (sha.length >= 7 && sha.length < 40) {
      for (let i = 0; i < this.N; i++) if (this.h[i].startsWith(sha)) return i;
    }
    return -1;
  }
  tagShas() {
    const m = new Map();
    for (const [n, c] of this.tags) m.set(n, this.h[c]);
    return m;
  }

  /** c 的全部祖先（含自己）。 */
  anc(c) {
    if (c < 0) return this.empty;
    let s = this.ancCache.get(c);
    if (s) return s;
    s = new Uint32Array(this.W);
    const P = this.P;
    s[c >>> 5] |= 1 << (c & 31);
    const st = [c];
    while (st.length) {
      const x = st.pop();
      for (const q of P[x]) {
        if (!((s[q >>> 5] >>> (q & 31)) & 1)) {
          s[q >>> 5] |= 1 << (q & 31);
          st.push(q);
        }
      }
    }
    this.ancCache.set(c, s);
    return s;
  }
  union(tips) {
    const s = new Uint32Array(this.W);
    for (const c of tips) {
      if (c < 0) continue;
      const a = this.anc(c);
      for (let i = 0; i < this.W; i++) s[i] |= a[i];
    }
    return s;
  }
  isAncestor(a, b) {
    return a === b || has(this.anc(b), a);
  }
  /** |A \ B| */
  countDiff(A, B) {
    let n = 0;
    for (let i = 0; i < this.W; i++) n += popcount(A[i] & ~B[i]);
    return n;
  }
  /** A \ B 里的提交，从新到旧 */
  listDiff(A, B, limit = Infinity) {
    const out = [];
    for (let i = 0; i < this.W && out.length < limit; i++) {
      let x = A[i] & ~B[i];
      while (x) {
        const b = x & -x;
        out.push((i << 5) + (31 - Math.clz32(b)));
        x ^= b;
        if (out.length >= limit) break;
      }
    }
    return out;
  }
  count(A) {
    let n = 0;
    for (let i = 0; i < this.W; i++) n += popcount(A[i]);
    return n;
  }

  /**
   * 一条线的第一父链，以及每个提交是被这条线上哪一次提交带进来的（intro[c] = 链上的位置，-1 表示不在这条线里）。
   * 链上的合并提交带进来的，是它的第二（及以后）父提交那一侧新出现的提交。
   */
  chain(tip) {
    if (tip < 0) return null;
    let T = this.chainCache.get(tip);
    if (T) return T;
    const P = this.P;
    const chain = [];
    for (let c = tip; c !== undefined; c = P[c][0]) chain.push(c);
    const pos = new Int32Array(this.N).fill(-1);
    chain.forEach((c, i) => (pos[c] = i));
    const intro = new Int32Array(this.N).fill(-1);
    for (let i = chain.length - 1; i >= 0; i--) {
      const t0 = chain[i];
      intro[t0] = i;
      const st = P[t0].slice(1);
      while (st.length) {
        const c = st.pop();
        if (intro[c] >= 0) continue;
        intro[c] = i;
        for (const q of P[c]) if (intro[q] < 0) st.push(q);
      }
    }
    T = { tip, chain, pos, intro };
    this.chainCache.set(tip, T);
    return T;
  }

  isMerge(c) {
    return this.P[c].length > 1;
  }
  short(c) {
    return this.h[c].slice(0, 7);
  }
  commitInfo(c) {
    if (c < 0) return null;
    return { sha: this.h[c], short: this.short(c), subject: this.s[c], author: this.a[c], time: this.t[c], ctime: this.ct[c], merge: this.isMerge(c) };
  }
}
