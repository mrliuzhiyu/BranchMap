// 仓库模型：在内存里走提交图，算出分支关系。不再调用任何 git 命令。
// 行号 = 提交在列表里的位置（按提交时间倒序，子提交一定在父提交之前）。
const SLOTS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];

function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
export const has = (set, i) => (set[i >>> 5] >>> (i & 31)) & 1;

export class Model {
  constructor(raw) {
    this.raw = raw;
    const C = raw.commits;
    this.N = C.h.length;
    this.W = (this.N + 31) >>> 5;
    this.h = C.h;
    this.P = C.p;
    this.a = C.a;
    this.t = C.t;
    this.ct = C.ct;
    this.s = C.s;
    this.byHash = new Map(C.h.map((h, i) => [h, i]));
    this.ancCache = new Map();
    this.trunkCache = new Map();

    // 人：按提交数排，前 8 位占用分类色，其余灰色（颜色跟着人走，不随筛选变）
    this.people = raw.people.map((p, id) => ({ ...p, id }));
    [...this.people].sort((x, y) => y.commits - x.commits).forEach((p, i) => {
      p.rank = i;
      p.color = SLOTS[i] ?? 'var(--other)';
    });

    // 引用
    this.refs = raw.refs.map((r) => ({ name: r.n, kind: r.k, c: r.c, up: r.up ?? null, track: r.tr ?? null, remote: r.remote ?? null, short: r.short ?? null, date: r.d ?? null, msg: r.m ?? null, ann: !!r.ann }));
    this.refsAt = new Map();
    for (const r of this.refs) {
      if (!this.refsAt.has(r.c)) this.refsAt.set(r.c, []);
      this.refsAt.get(r.c).push(r);
    }
    this.tags = this.refs.filter((r) => r.kind === 'T').map((r) => ({ ...r, date: r.date ?? this.ct[r.c] })).sort((x, y) => y.date - x.date || x.c - y.c);

    // 分支：本地和 origin 上的同名分支合成一条
    this.branches = new Map();
    const branch = (name) => {
      if (!this.branches.has(name)) this.branches.set(name, { name, local: null, remote: null, tip: -1 });
      return this.branches.get(name);
    };
    for (const r of this.refs) {
      if (r.kind === 'L') branch(r.name).local = r;
      else if (r.kind === 'R') branch(r.remote === 'origin' ? r.short : r.name).remote = r;
    }
    for (const B of this.branches.values()) B.tip = this.pickTip(B);

    this.worktrees = raw.worktrees;
    this.head = raw.head;
    this.headCommit = raw.worktrees.find((w) => w.main)?.c ?? -1;
    this.trunk = raw.trunk;
    this.prodB = raw.trunk.prod ? this.branches.get(raw.trunk.prod) ?? null : null;
    this.devB = raw.trunk.dev ? this.branches.get(raw.trunk.dev) ?? null : null;
    this.prs = null;
  }

  /* ---------- 可达性（位图） ---------- */
  anc(c) {
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
  isAncestor(a, b) {
    return a === b || !!has(this.anc(b), a);
  }
  /** |A \ B| */
  countDiff(A, B) {
    let n = 0;
    for (let i = 0; i < this.W; i++) n += popcount(A[i] & ~B[i]);
    return n;
  }
  /** A \ B 里的提交（从新到旧） */
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
  union(tips) {
    const s = new Uint32Array(this.W);
    for (const c of tips) {
      const a = this.anc(c);
      for (let i = 0; i < this.W; i++) s[i] |= a[i];
    }
    return s;
  }

  /** 本地与远程不一致时取哪个：一方是另一方的祖先就取新的，分叉了取提交时间新的。 */
  pickTip(B) {
    const l = B.local?.c ?? -1;
    const r = B.remote?.c ?? -1;
    if (l < 0) return r;
    if (r < 0 || l === r) return l;
    if (this.isAncestor(l, r)) return r;
    if (this.isAncestor(r, l)) return l;
    return this.ct[l] >= this.ct[r] ? l : r;
  }

  /* ---------- 主线：第一父链 + 每个提交是被主线上哪次提交带进来的 ---------- */
  trunkInfo(tip) {
    if (tip < 0) return null;
    if (this.trunkCache.has(tip)) return this.trunkCache.get(tip);
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
    const info = { tip, chain, pos, intro, set: this.anc(tip) };
    this.trunkCache.set(tip, info);
    return info;
  }

  get prodTip() { return this.prodB?.tip ?? -1; }
  get devTip() { return this.devB?.tip ?? -1; }
  get prodT() { return this.trunkInfo(this.prodTip); }
  get devT() { return this.trunkInfo(this.devTip); }
  /** 各分支「自己的工作」以哪条线为准：有 dev 用 dev，否则 main。 */
  get baseB() { return this.devB ?? this.prodB; }

  /* ---------- main ↔ dev ---------- */
  trunkRelation() {
    if (this._trunkRel !== undefined) return this._trunkRel;
    const prodT = this.prodT;
    const devT = this.devT;
    if (!prodT || !devT) return (this._trunkRel = null);
    const devOnly = this.listDiff(devT.set, prodT.set);
    const prodOnly = this.listDiff(prodT.set, devT.set);
    let mergeBase = -1;
    for (let i = 0; i < this.N; i++) if (has(prodT.set, i) && has(devT.set, i)) { mergeBase = i; break; }
    // 上次 dev → main：main 第一父链上最近一个「第二父提交在 dev 里」的合并
    const lastPromote = prodT.chain.find((c) => this.P[c].length > 1 && this.P[c].slice(1).some((q) => has(devT.set, q)));
    // 上次 main → dev（回合）：dev 第一父链上最近一个「第二父提交在 main 里」的合并
    const lastBackMerge = devT.chain.find((c) => this.P[c].length > 1 && this.P[c].slice(1).some((q) => has(prodT.set, q)));
    this._trunkRel = {
      devOnly,
      prodOnly,
      mergeBase,
      devGroups: this.groupByChain(devOnly, devT),
      prodGroups: this.groupByChain(prodOnly, prodT),
      lastPromote: lastPromote ?? -1,
      lastBackMerge: lastBackMerge ?? -1,
      sync: [this.prodB, this.devB].map((B) => this.syncState(B)).filter(Boolean),
    };
    return this._trunkRel;
  }
  /** 本地分支和远程分支差几个。 */
  syncState(B) {
    if (!B?.local || !B?.remote || B.local.c === B.remote.c) return null;
    const L = this.anc(B.local.c);
    const R = this.anc(B.remote.c);
    return { name: B.name, remote: B.remote.name, ahead: this.countDiff(L, R), behind: this.countDiff(R, L) };
  }
  /** 把「一条线有、另一条没有」的提交按这条线上的合并分组：一次合并 = 一项功能，连续的直接提交并成一组。 */
  groupByChain(list, T) {
    const groups = new Map();
    for (const c of list) {
      const k = T.intro[c];
      if (k < 0) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    const out = [];
    for (const k of [...groups.keys()].sort((x, y) => x - y)) {
      const m = T.chain[k];
      const commits = groups.get(k);
      if (this.P[m].length > 1) {
        const work = commits.filter((c) => c !== m);
        out.push({ kind: 'merge', merge: m, commits: work.length ? work : commits, time: this.ct[m], authors: this.authorsOf(work.length ? work : [m]) });
      } else {
        const last = out.at(-1);
        if (last?.kind === 'direct') {
          last.commits.push(...commits);
          last.authors = this.authorsOf(last.commits);
        } else out.push({ kind: 'direct', merge: m, commits: [...commits], time: this.ct[m], authors: this.authorsOf(commits) });
      }
    }
    for (const g of out) g.label = this.groupLabel(g);
    return out;
  }
  authorsOf(list) {
    const tally = new Map();
    for (const c of list) tally.set(this.a[c], (tally.get(this.a[c]) ?? 0) + 1);
    return [...tally].sort((x, y) => y[1] - x[1]).map(([id]) => id);
  }
  groupLabel(g) {
    if (g.kind === 'direct') return { title: g.commits.length === 1 ? this.s[g.commits[0]] : `${g.commits.length} 个直接提交`, branch: null, pr: null };
    const m = g.merge;
    const pr = this.prByMerge?.get(this.h[m]) ?? null;
    const subj = this.s[m];
    let branch = null;
    let prNum = pr?.n ?? null;
    let x = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)/.exec(subj);
    if (x) { prNum ??= Number(x[1]); branch = x[2]; }
    else if ((x = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(subj))) branch = x[1].replace(/^origin\//, '');
    else if ((x = /\(#(\d+)\)\s*$/.exec(subj))) prNum ??= Number(x[1]);
    const title = pr?.title ?? (x && /^Merge/.test(subj) ? this.bodyTitle(g) : subj);
    return { title, branch: pr?.head ?? branch, pr: pr ?? (prNum ? { n: prNum, state: 'MERGED' } : null) };
  }
  /** 合并提交标题没信息量时，用被合进来的最后一个普通提交的标题。 */
  bodyTitle(g) {
    const c = g.commits.find((x) => this.P[x].length < 2);
    return c !== undefined ? this.s[c] : this.s[g.merge];
  }

  /* ---------- PR ---------- */
  setPrs(list) {
    this.prs = list;
    this.prByMerge = new Map();
    this.prByHead = new Map();
    for (const p of [...list].sort((x, y) => x.updated - y.updated)) {
      if (p.mergeCommit) this.prByMerge.set(p.mergeCommit, p);
      this.prByHead.set(p.head, p);
    }
    this._trunkRel = undefined;
  }
  /** 分支对应的 PR：打开的，或者结束时间不早于分支最新提交的（旧的一轮 PR 不算）。 */
  prOf(row) {
    const p = this.prByHead?.get(row.name);
    if (!p) return null;
    if (p.state === 'OPEN' || p.state === 'DRAFT') return p;
    return (p.merged ?? p.updated) >= this.ct[row.tip] - 120 ? p : null;
  }

  /* ---------- 一个提交在哪些分支 / 标签里 ---------- */
  containedIn(c) {
    const branches = [];
    for (const B of this.branches.values()) if (B.tip >= 0 && has(this.anc(B.tip), c)) branches.push(B);
    let firstTag = null;
    for (const t of this.tags) if (has(this.anc(t.c), c) && (!firstTag || t.date < firstTag.date)) firstTag = t;
    return { branches, firstTag };
  }

  /* ---------- 杂项 ---------- */
  resolve(ref) {
    if (ref == null) return -1;
    if (this.byHash.has(ref)) return this.byHash.get(ref);
    const B = this.branches.get(ref);
    if (B) return B.tip;
    const r = this.refs.find((x) => x.name === ref);
    if (r) return r.c;
    if (/^[0-9a-f]{6,40}$/.test(ref)) {
      for (let i = 0; i < this.N; i++) if (this.h[i].startsWith(ref)) return i;
    }
    return -1;
  }
  isMerge(c) { return this.P[c].length > 1; }
  short(c) { return this.h[c].slice(0, 7); }
  person(id) { return this.people[id] ?? null; }
}
