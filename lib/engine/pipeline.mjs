// 流水线：把一个项目看成「功能分支 → dev → 测试环境 → main → 生产环境」这样一串站，
// 算出每一站现在在哪、相邻两站差多少、每件在途的工作（按工单 / PR / 分支归组）走到了哪一站、每个人手上有什么。
// 站的顺序来自配置里的 flow（没写就自动识别 dev / main），环境挂在它从哪条分支部署的后面。
import { has } from './graph.mjs';

const DAY = 86400;
const PROD_NAMES = ['main', 'master', 'trunk', 'production', 'prod'];
const DEV_NAMES = ['dev', 'develop', 'development', 'staging'];
const TICKET_STOP = new Set(['UTF', 'SHA', 'ISO', 'RFC', 'HTTP', 'HTTPS', 'TLS', 'SSL', 'AES', 'RSA', 'CVE', 'GB', 'MD', 'X', 'ES', 'H', 'P', 'V', 'TODO', 'FIXME', 'COVID', 'IPV']);
const BOT_NAME = /(\[bot\]|^bot$|-bot$|^claude$|^codex$|^copilot|dependabot|renovate|github-actions)/i;
const AGENT_BRANCH = /^(codex|claude|cursor|copilot|devin|agent|worktree|ai)\//i;

/** 主线：配置里写了就用配置，否则 dev 类 + 默认分支。返回存在的分支名数组（按流向）。 */
export function detectFlow(G, configured) {
  if (configured?.length) return configured.filter((n) => G.branchTip(n) >= 0);
  const names = [...G.branches.keys()];
  const prod = G.defaultBranch && !DEV_NAMES.includes(G.defaultBranch) && G.branchTip(G.defaultBranch) >= 0 ? G.defaultBranch : PROD_NAMES.find((n) => names.includes(n)) ?? null;
  const dev = DEV_NAMES.find((n) => names.includes(n) && n !== prod) ?? null;
  return [dev, prod].filter(Boolean);
}

/** 工单号：配置了就按配置，否则从提交说明里学——同一个前缀出现过至少 3 个不同编号才算工单。 */
export function ticketMatcher(G, cfg) {
  if (cfg?.pattern) {
    const re = new RegExp(cfg.pattern);
    return (s) => {
      const m = re.exec(s);
      return m ? (m[1] ?? m[0]).toUpperCase() : null;
    };
  }
  const re = /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]{1,9})-(\d{1,6})(?![A-Za-z0-9])/g;
  let prefixes = cfg?.prefixes ? new Set(cfg.prefixes.map((p) => p.toUpperCase())) : null;
  if (!prefixes) {
    const seen = new Map();
    for (const s of G.s) {
      for (const m of s.matchAll(re)) {
        if (TICKET_STOP.has(m[1])) continue;
        if (!seen.has(m[1])) seen.set(m[1], new Set());
        seen.get(m[1]).add(m[2]);
      }
    }
    prefixes = new Set([...seen].filter(([, nums]) => nums.size >= 3).map(([p]) => p));
  }
  return (s) => {
    for (const m of s.matchAll(re)) if (prefixes.has(m[1])) return `${m[1]}-${m[2]}`;
    return null;
  };
}

/** 去掉说明里的工单号前缀：「修复(SIL-449)：xxx」→「xxx」 */
function cleanTitle(s, ticket) {
  if (!ticket) return s;
  const t = ticket.replace(/[-]/g, '\\-');
  const out = s
    .replace(new RegExp(`^\\s*[^\\s:：(（]{0,12}\\s*[(（\\[]\\s*${t}\\s*[)）\\]]\\s*[:：]?\\s*`, 'i'), '')
    .replace(new RegExp(`^\\s*\\[?${t}\\]?\\s*[:：-]?\\s*`, 'i'), '');
  return out.trim() || s;
}

/** 合并提交的说明里能读出什么：PR 号、被合进来的分支。 */
function parseMerge(subject) {
  let m = /^Merge pull request #(\d+) from ([^/\s]+)\/(\S+)/.exec(subject);
  if (m) return { pr: Number(m[1]), branch: m[3] };
  m = /^Merge (?:remote-tracking )?branch '([^']+)'(?: of \S+)?(?: into (\S+))?/.exec(subject);
  if (m) return { pr: null, branch: m[1].replace(/^origin\//, ''), into: m[2] ?? null };
  m = /^Merge (?:remote-tracking )?branch "([^"]+)"/.exec(subject);
  if (m) return { pr: null, branch: m[1].replace(/^origin\//, '') };
  m = /\(#(\d+)\)\s*$/.exec(subject);
  if (m) return { pr: Number(m[1]), branch: null, squash: true };
  return null;
}

/**
 * @param {object} o
 *   G        CommitGraph（云端副本）
 *   flow     主线分支名（按流向），如 ['dev', 'main']
 *   envs     [{ id, name, branch, url, kind, note, result }]
 *   prs      gh 拿到的 PR 列表（可能为 null）
 *   tickets  工单配置 { pattern?, prefixes?, url? }
 */
export function analyze({ G, flow, envs, prs, tickets, windowDays, staleDays, now = Math.floor(Date.now() / 1000) }) {
  const since = now - windowDays * DAY;
  const ticketOf = ticketMatcher(G, tickets);
  const prByMerge = new Map();
  const prByNum = new Map();
  const prByHead = new Map();
  for (const p of [...(prs ?? [])].sort((x, y) => x.updated - y.updated)) {
    if (p.mergeCommit) prByMerge.set(p.mergeCommit, p);
    prByNum.set(p.n, p);
    prByHead.set(p.head, p);
  }

  /* ---------- 站 ---------- */
  const stages = [];
  const placed = new Set();
  for (const b of flow) {
    const tip = G.branchTip(b);
    stages.push({ key: 'b:' + b, kind: 'branch', name: b, tipIdx: tip, set: G.anc(tip), known: true });
    for (const e of envs.filter((x) => x.branch === b)) {
      stages.push(envStage(G, e));
      placed.add(e.id);
    }
  }
  const extraEnvs = envs.filter((e) => !placed.has(e.id)).map((e) => envStage(G, e));
  const known = stages.filter((s) => s.known);
  // 能判断到的最远一站：它后面的站（比如读不出版本的生产环境）没法说东西到没到
  const doneSeg = stages.reduce((m, s, i) => (s.known ? i + 1 : m), 0);
  const first = known[0] ?? null;
  const last = known.at(-1) ?? null;

  /* ---------- 每条主线分支的第一父链（谁、哪次合并把提交带进来的） ---------- */
  const chains = new Map();
  for (const s of stages) if (s.kind === 'branch') chains.set(s.name, G.chain(s.tipIdx));

  /* ---------- 云端分支 ---------- */
  const flowSet = new Set(flow);
  const baseSet = first?.set ?? G.empty;
  const branchRows = [];
  for (const [name, tip] of G.branches) {
    if (flowSet.has(name) || name === 'HEAD') continue;
    const A = G.anc(tip);
    const ownList = G.listDiff(A, baseSet).filter((c) => !G.isMerge(c));
    const behind = first ? G.countDiff(baseSet, A) : null;
    let status;
    if (!first) status = G.ct[tip] >= now - staleDays * DAY ? 'active' : 'stale';
    else if (ownList.length === 0) status = last && has(last.set, tip) ? 'released' : 'merged';
    else status = G.ct[tip] >= now - staleDays * DAY ? 'active' : 'stale';
    const tally = new Map();
    for (const c of ownList) tally.set(G.a[c], (tally.get(G.a[c]) ?? 0) + 1);
    const owner = tally.size ? [...tally].sort((x, y) => y[1] - x[1])[0][0] : G.a[tip];
    const tks = new Set();
    for (const c of ownList) {
      const t = ticketOf(G.s[c]);
      if (t) tks.add(t);
    }
    const pr = prByHead.get(name);
    branchRows.push({
      name,
      tipIdx: tip,
      tip: G.commitInfo(tip),
      time: G.ct[tip],
      own: ownList.length,
      ownList,
      behind,
      status,
      owner,
      people: [...tally.keys()],
      tickets: [...tks].slice(0, 6),
      agent: AGENT_BRANCH.test(name),
      pr: pr && (pr.state === 'OPEN' || pr.state === 'DRAFT' || (pr.merged ?? pr.updated) >= G.ct[tip] - 120) ? slimPr(pr) : null,
    });
  }
  branchRows.sort((x, y) => y.time - x.time);

  /* ---------- 要列出的提交 ---------- */
  const activeBranches = branchRows.filter((b) => b.status === 'active');
  const tipsAll = [...G.branches.values(), ...stages.filter((s) => s.kind === 'env' && s.tipIdx >= 0).map((s) => s.tipIdx)];
  const U = G.union(tipsAll);
  const doneSet = last?.set ?? G.empty;
  // 功能分支上的提交：每个提交归给包含它、自己独有提交最少的那条活跃分支
  const featureOwner = new Map();
  for (const b of [...activeBranches].sort((x, y) => x.own - y.own)) {
    for (const c of b.ownList) if (!featureOwner.has(c)) featureOwner.set(c, b);
  }
  const candidates = [];
  for (let c = 0; c < G.N; c++) {
    if (!has(U, c) || G.isMerge(c)) continue;
    const inBase = has(baseSet, c);
    if (first && !inBase) {
      // 只在功能分支上：只看活跃分支（停滞的分支在「分支」和健康检查里看）
      if (featureOwner.has(c)) candidates.push(c);
      continue;
    }
    if (!has(doneSet, c) || G.t[c] >= since || G.ct[c] >= since) candidates.push(c);
  }

  /* ---------- 每个提交在哪些站里 ---------- */
  const inStage = (c) => stages.map((s) => (s.known ? has(s.set, c) : null));
  const segOf = (mask) => {
    // 走到的最远一站：从前往后，已知的站里最后一个包含它的（中间未知的环境跳过）
    let seg = 0;
    stages.forEach((s, i) => {
      if (mask[i]) seg = i + 1;
    });
    return seg;
  };

  /* ---------- 归组：工单 > PR > 分支 > 某人的直接提交 ---------- */
  const groups = new Map();
  const add = (key, init, c) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, ...init, commits: [], prs: new Map(), branches: new Set() }));
    g.commits.push(c);
    return g;
  };
  for (const c of candidates) {
    const subject = G.s[c];
    const ticket = ticketOf(subject);
    // 这个提交是怎么进主线的
    let via = null;
    for (const s of stages) {
      if (s.kind !== 'branch' || !has(s.set, c)) continue;
      const T = chains.get(s.name);
      const k = T.intro[c];
      if (k < 0) continue;
      const m = T.chain[k];
      if (m !== c && G.isMerge(m)) {
        const info = parseMerge(G.s[m]);
        const pr = prByMerge.get(G.h[m]) ?? (info?.pr ? prByNum.get(info.pr) : null);
        const branch = pr?.head ?? info?.branch ?? null;
        // 把主线合进功能分支的「同步」合并不算一项工作
        if (!(branch && (flowSet.has(branch) || branch === 'HEAD'))) via = { merge: m, pr: pr ? slimPr(pr) : info?.pr ? { n: info.pr } : null, branch };
      }
      break;
    }
    const fb = featureOwner.get(c);
    const mask = inStage(c);
    const seg = segOf(mask);
    let g;
    if (ticket) g = add('t:' + ticket, { kind: 'ticket', ticket }, c);
    else if (via?.pr?.n) g = add('pr:' + via.pr.n, { kind: 'pr' }, c);
    else if (via?.branch) g = add('b:' + via.branch, { kind: 'branch', branchName: via.branch }, c);
    else if (fb) g = add('b:' + fb.name, { kind: 'branch', branchName: fb.name }, c);
    else g = add(`d:${G.a[c]}:${seg}:${startOfDay(G.t[c])}`, { kind: 'direct', author: G.a[c], day: startOfDay(G.t[c]) }, c);
    if (via?.pr?.n) g.prs.set(via.pr.n, via.pr);
    if (via?.branch) g.branches.add(via.branch);
    if (fb) {
      g.branches.add(fb.name);
      if (fb.pr) g.prs.set(fb.pr.n, fb.pr);
    }
  }

  const items = [];
  for (const g of groups.values()) {
    const cs = g.commits.sort((x, y) => x - y); // 新 → 旧
    const counts = stages.map((s) => (s.known ? cs.reduce((n, c) => n + (has(s.set, c) ? 1 : 0), 0) : null));
    // 这件工作走到的站：所有提交都已经进了的最远一站
    let seg = 0;
    stages.forEach((s, i) => {
      if (s.known && counts[i] === cs.length) seg = i + 1;
    });
    // 最远的已知站都有了，但中间某站没全有：按最远的算（比如跳过测试直接上了生产）
    const tally = new Map();
    for (const c of cs) tally.set(G.a[c], (tally.get(G.a[c]) ?? 0) + 1);
    const people = [...tally].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    const oldest = cs.at(-1);
    const titleSrc = g.kind === 'ticket' ? oldest : cs[0];
    const prList = [...g.prs.values()].map((p) => ({ ...p, ...(prByNum.has(p.n) ? slimPr(prByNum.get(p.n)) : {}) }));
    let title;
    if (g.kind === 'ticket') title = cleanTitle(G.s[titleSrc], g.ticket);
    else if (g.kind === 'pr') title = prList[0]?.title ?? G.s[cs[0]];
    else if (g.kind === 'branch') title = G.s[cs[0]];
    else title = G.s[cs[0]];
    const last = Math.max(...cs.map((c) => G.ct[c]));
    // 已经走到能判断的最远一站、而且窗口期之前就动完了：不列
    if (doneSeg && seg >= doneSeg && last < since) continue;
    items.push({
      key: g.key,
      kind: g.kind,
      ticket: g.ticket ?? null,
      day: g.day ?? null,
      ticketUrl: g.ticket && tickets?.url ? tickets.url.replaceAll('{id}', g.ticket) : null,
      branch: g.branchName ?? [...g.branches][0] ?? null,
      branches: [...g.branches].slice(0, 8),
      prs: prList,
      title,
      people,
      count: cs.length,
      counts,
      seg,
      first: Math.min(...cs.map((c) => G.t[c])),
      last,
      commits: cs.slice(0, 200).map((c) => ({ i: c, sha: G.h[c], s: G.s[c], a: G.a[c], t: G.t[c], ct: G.ct[c], in: inStage(c) })),
    });
  }
  items.sort((x, y) => x.seg - y.seg || y.last - x.last);

  /* ---------- 相邻两站的差距 ---------- */
  const gaps = [];
  for (let i = 0; i < stages.length - 1; i++) {
    let from = i;
    const b = stages[i + 1];
    // 前一站读不出版本：跳过它，和再往前最近一个读得出的站比（比如测试读不出，就直接看 dev → main）
    while (from >= 0 && !stages[from].known) from--;
    if (from < 0 || !b.known) {
      gaps.push({ from: i, to: i + 1, pending: null, reverse: null });
      continue;
    }
    const a = stages[from];
    const pendingList = G.listDiff(a.set, b.set).filter((c) => !G.isMerge(c));
    const reverseList = G.listDiff(b.set, a.set).filter((c) => !G.isMerge(c));
    gaps.push({
      from, // 实际比较的那一站（跳过了读不出版本的站时，不是紧挨着的前一站）
      to: i + 1,
      skipped: from !== i,
      pending: pendingList.length,
      oldest: pendingList.length ? Math.min(...pendingList.map((c) => G.ct[c])) : null,
      reverse: reverseList.length,
      reverseSample: reverseList.slice(0, 20).map((c) => G.commitInfo(c)),
    });
  }
  // 各环境相对它的来源分支
  for (const s of [...stages, ...extraEnvs]) {
    if (s.kind !== 'env' || !s.known || !s.branch) continue;
    const src = G.branchTip(s.branch);
    if (src < 0) continue;
    const S = G.anc(src);
    // 只数真正带改动的提交（合并提交不算），否则数字虚高
    const pend = G.listDiff(S, s.set).filter((c) => !G.isMerge(c));
    s.behindBranch = pend.length;
    s.offBranch = G.listDiff(s.set, S).filter((c) => !G.isMerge(c)).length;
    s.waitingSince = pend.length ? Math.min(...pend.map((c) => G.ct[c])) : null;
  }

  // 两条主线直接互相比（不管中间隔着几个环境）：
  //   ahead  —— 集成分支有、上线分支没有：待上线
  //   behind —— 上线分支有、集成分支没有：没回合（直接改在上线分支上的）
  // 一组提交打成包：数量、最早一个的时间、涉及的成员、工单、明细（最多 200 条）
  const pack = (list) => {
    const tally = new Map();
    const tks = new Set();
    for (const c of list) {
      tally.set(G.a[c], (tally.get(G.a[c]) ?? 0) + 1);
      const t = ticketOf(G.s[c]);
      if (t) tks.add(t);
    }
    return {
      count: list.length,
      oldest: list.length ? Math.min(...list.map((c) => G.ct[c])) : null,
      people: [...tally].sort((x, y) => y[1] - x[1]).map(([id, n]) => ({ id, n })),
      tickets: [...tks],
      commits: list.slice(0, 200).map((c) => ({ sha: G.h[c], s: G.s[c], a: G.a[c], t: G.t[c], ticket: ticketOf(G.s[c]) })),
    };
  };
  let trunk = null;
  if (flow.length > 1) {
    const D = G.anc(G.branchTip(flow[0]));
    const Mn = G.anc(G.branchTip(flow.at(-1)));
    trunk = {
      dev: flow[0],
      main: flow.at(-1),
      ahead: pack(G.listDiff(D, Mn).filter((c) => !G.isMerge(c))),
      behind: pack(G.listDiff(Mn, D).filter((c) => !G.isMerge(c))),
    };
  }

  // 相邻的两个环境（中间隔着分支）：后一个有、前一个没有 = 跳过了前一个环境
  const knownEnvs = stages.filter((s) => s.kind === 'env' && s.known);
  // 环境对比（发布前核对用）：相邻两个环境，前一个有、后一个没有 = 下次发布会带上的；反过来 = 没经过前一个就上了后一个
  const envCompare = [];
  for (let k = 1; k < knownEnvs.length; k++) {
    const e1 = knownEnvs[k - 1];
    const e2 = knownEnvs[k];
    envCompare.push({ from: e1.envId, fromName: e1.name, to: e2.envId, toName: e2.name, pending: pack(G.listDiff(e1.set, e2.set).filter((c) => !G.isMerge(c))), skipped: pack(G.listDiff(e2.set, e1.set).filter((c) => !G.isMerge(c))) });
  }
  for (let k = 1; k < knownEnvs.length; k++) {
    const list = G.listDiff(knownEnvs[k].set, knownEnvs[k - 1].set).filter((c) => !G.isMerge(c));
    knownEnvs[k].skipCount = list.length;
    knownEnvs[k].skipSample = list.slice(0, 20).map((c) => G.commitInfo(c));
    knownEnvs[k].skipOf = knownEnvs[k - 1].name;
  }

  /* ---------- 每一站 ---------- */
  const segments = [{ seg: 0, label: first ? `还在分支上` : '最近的提交', hint: first ? `还没合进 ${first.name}` : '' }];
  stages.forEach((s, i) => {
    // 读不出版本的站不会「包含」任何提交，也就没有停在那儿的工作
    if (!s.known || i + 1 > doneSeg) return;
    // 下一个能判断的站（跳过读不出版本的环境）
    const skipped = [];
    let j = i + 1;
    while (j < stages.length && !stages[j].known) skipped.push(stages[j++].name);
    const next = stages[j];
    const here = s.kind === 'env' ? '已在' + s.name : '已进 ' + s.name;
    const note = skipped.length ? `（${skipped.join('、')}读不出版本）` : '';
    let label;
    let hint;
    if (!next) {
      label = s.kind === 'env' ? `已上${s.name}` : `已进 ${s.name}`;
      hint = skipped.length ? `后面的${skipped.join('、')}读不出版本，只能看到这一站` : `最近 ${windowDays} 天里走完全程的`;
    } else if (next.kind === 'env') {
      label = `待部署${next.name}`;
      hint = `${here}，${next.name}还没有${note}`;
    } else {
      label = `待合入 ${next.name}`;
      hint = `${here}，还没合进 ${next.name}${note}`;
    }
    segments.push({ seg: i + 1, label, hint });
  });
  for (const sg of segments) sg.count = items.filter((x) => x.seg === sg.seg).length;

  // 每条主线分支最近 24 小时进来多少提交
  for (const s of stages) {
    if (s.kind !== 'branch') continue;
    const T = chains.get(s.name);
    let n = 0;
    const recentPos = new Set();
    for (let k = 0; k < T.chain.length && G.ct[T.chain[k]] >= now - DAY; k++) recentPos.add(k);
    if (recentPos.size) for (let c = 0; c < G.N; c++) if (T.intro[c] >= 0 && recentPos.has(T.intro[c]) && !G.isMerge(c)) n++;
    s.recent24 = n;
    s.lastUpdate = s.tipIdx >= 0 ? G.ct[s.tipIdx] : null;
  }

  /* ---------- 人 ---------- */
  const people = G.people.map((p, id) => ({ id, name: p.name, names: p.names, avatar: p.avatar, login: p.login, bot: BOT_NAME.test(p.name) || p.names.every((n) => BOT_NAME.test(n)), last: 0, d7: 0, d14: new Array(14).fill(0), items: [], branches: [], landed: 0 }));
  const today = startOfDay(now);
  for (let c = 0; c < G.N; c++) {
    const pp = people[G.a[c]];
    if (!pp) continue;
    const t = G.t[c];
    if (t > pp.last) pp.last = t;
    if (G.isMerge(c)) continue;
    if (t >= now - 7 * DAY) pp.d7++;
    const d = Math.floor((today - startOfDay(t)) / DAY);
    if (d >= 0 && d < 14) pp.d14[13 - d]++;
    if (first && has(baseSet, c) && G.ct[c] >= now - 7 * DAY) pp.landed++;
  }
  for (const it of items) for (const id of it.people) people[id]?.items.push(it.key);
  for (const b of branchRows) if (b.status === 'active' || b.status === 'stale') people[b.owner]?.branches.push(b.name);

  return {
    flow,
    stages: stages.map(publicStage(G)),
    extraEnvs: extraEnvs.map(publicStage(G)),
    gaps,
    segments,
    items,
    branches: branchRows.map(({ ownList, tipIdx, ...b }) => b),
    people: people.filter((p) => p.last >= since || p.items.length || p.branches.length).sort((x, y) => y.last - x.last),
    windowDays,
    doneSeg,
    trunk,
    envCompare,
    pack, // 给快照算上线记录用，不进 JSON
  };
}

function envStage(G, e) {
  const r = e.result ?? { state: 'unconfigured' };
  const idx = r.commit ? G.resolve(r.commit) : -1;
  return {
    key: 'e:' + e.id,
    kind: 'env',
    envId: e.id,
    name: e.name,
    branch: e.branch,
    url: e.url,
    envKind: e.kind,
    note: e.note,
    probeUrl: e.probe?.url ?? null,
    result: r,
    tipIdx: idx,
    set: idx >= 0 ? G.anc(idx) : null,
    known: idx >= 0,
    // 读到了提交号、但云端副本里没有这个提交（还没同步到，或者是从没推送的代码部署的）
    foreign: !!r.commit && idx < 0,
  };
}

const publicStage = (G) => (s) => {
  const { set, tipIdx, ...rest } = s;
  return { ...rest, tip: tipIdx >= 0 ? G.commitInfo(tipIdx) : null };
};

function slimPr(p) {
  return { n: p.n, title: p.title, state: p.state, url: p.url, by: p.by, head: p.head, base: p.base, merged: p.merged ?? null, updated: p.updated, review: p.review ?? null, ci: p.ci ?? null };
}

function startOfDay(t) {
  const d = new Date(t * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}
