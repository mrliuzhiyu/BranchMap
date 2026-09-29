// 提交的差异怎么加载：给「改动」抽屉用（文本差异 + 图片前后对比）。

export function commitChangesLoader(store, base, to) {
  return {
    load: (f, opts) => store.diff({ from: base ?? 'EMPTY', to, path: f.p, old: f.old, ctx: opts.ctx, ws: opts.ws }),
    images: (f) => ({
      before: f.st === 'A' || !base ? null : store.rawUrl(base, f.old ?? f.p),
      after: f.st === 'D' ? null : store.rawUrl(to, f.p),
    }),
  };
}
