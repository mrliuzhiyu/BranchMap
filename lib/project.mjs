// 项目 = 一个远程仓库。把三份数据接到一起：
//   云端副本（团队真实进度） + 环境探测（线上跑的是什么） + 本机扫描（我推上去了没有）
// 再交给引擎算出流水线、在途工作、成员和健康信号。任何一份数据变了就重算，并通知页面。
import { EventEmitter } from 'node:events';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Mirror } from './sources/cloud.mjs';
import { saveEnvironments, normalizeEnv, normalizeProject, updateProjectConfig, reorderProjectsConfig } from './config.mjs';
import { LocalScanner } from './sources/local.mjs';
import { EnvProbe } from './sources/env.mjs';
import { Repo } from './repo.mjs';
import { Accounts } from './people.mjs';
import { GitHub } from './github.mjs';
import { CommitGraph } from './engine/graph.mjs';
import { analyze, detectFlow } from './engine/pipeline.mjs';
import { check } from './engine/health.mjs';
import { remoteKey, githubSlug, webUrl } from './remote.mjs';
import { firstLine } from './git.mjs';

const TICK = 5000;

/**
 * 上线记录：每次探测到某个环境换了提交，就记一条 { env, t, from, to, version }。
 * t 是 BranchMap 发现的时间（最多晚一个探测周期），不是部署系统的时间。存在 .cache/deploys/ 下。
 */
class DeployLog {
  constructor(file) {
    this.file = file;
    try {
      this.list = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      this.list = [];
    }
  }
  last(env) {
    for (let i = this.list.length - 1; i >= 0; i--) if (this.list[i].env === env) return this.list[i];
    return null;
  }
  record(env, commit, version) {
    const prev = this.last(env);
    if (prev && prev.to === commit) return false;
    this.list.push({ env, t: Math.floor(Date.now() / 1000), from: prev?.to ?? null, to: commit, version: version ?? null });
    if (this.list.length > 1000) this.list = this.list.slice(-1000);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.list));
    } catch { /* 写不了就只留在内存里 */ }
    return true;
  }
}
const DISCOVER_EVERY = 5 * 60 * 1000;

export class Workspace extends EventEmitter {
  constructor(cfg) {
    super();
    this.setMaxListeners(100);
    this.cfg = cfg;
    this.scanner = new LocalScanner({ roots: cfg.scan, extra: cfg.extraRepos });
    this.accounts = new Accounts(cfg.cacheDir);
    // 连接 GitHub（GitHub App）：读 PR / CI / 头像、拉代码的令牌都从这里拿；没连时退回本机 gh 的登录
    this.github = new GitHub(cfg.cacheDir);
    this.projects = new Map(); // id -> Project
    this.byKey = new Map(); // 远程键 -> Project
    this.discoveredAt = 0;
  }

  async init() {
    await this.scanner.discover();
    this.discoveredAt = Date.now();
    this.reconcile();
  }

  /** 按「配置里的项目 ∪ 本机扫到的远程」建项目。 */
  /**
   * 按配置建项目。配置里写了项目，就只显示配置里的（项目化：扫描目录只用来「发现」候选仓库）；
   * 一个都没写时退回到「扫到什么显示什么」。
   */
  reconcile() {
    const confByKey = new Map(this.cfg.projects.map((p) => [p.key, p]));
    const keys = this.cfg.projects.length ? new Set(confByKey.keys()) : new Set([...confByKey.keys(), ...this.scanner.byKey.keys()]);
    for (const [key, p] of this.byKey) {
      if (!keys.has(key) || confByKey.get(key)?.hidden) {
        this.byKey.delete(key);
        this.projects.delete(p.id);
      }
    }
    const usedIds = new Set([...this.projects.values()].map((p) => p.id));
    for (const key of keys) {
      if (this.byKey.has(key)) continue;
      const conf = confByKey.get(key) ?? null;
      if (conf?.hidden) continue;
      const url = conf?.remote ?? this.scanner.byKey.get(key)?.url;
      if (!url) continue;
      let id = conf?.id ?? key.split('/').pop();
      if (usedIds.has(id)) id = key.split('/').slice(-2).join('-');
      for (let i = 2; usedIds.has(id); i++) id = `${key.split('/').pop()}-${i}`;
      usedIds.add(id);
      const p = new Project(this, { id, key, url, conf });
      this.projects.set(id, p);
      this.byKey.set(key, p);
    }
  }

  list() {
    return [...this.projects.values()];
  }

  /** 扫描目录里找到、但还没加成项目的仓库（「添加项目」里的候选）。 */
  discovered() {
    const shown = new Set(this.byKey.keys());
    return [...this.scanner.byKey].filter(([key]) => !shown.has(key)).map(([key, v]) => {
      const main = v.repos[0];
      return { key, remote: v.url, name: key.split('/').pop(), path: main?.worktrees.find((w) => w.main)?.path ?? main?.gitDir ?? null, checkouts: v.repos.reduce((n, r) => n + r.worktrees.filter((w) => !w.bare).length, 0) };
    });
  }

  /** 添加项目（或把移除过的加回来）：写进 config.json，马上开始建云端副本。返回项目 id。 */
  addProject({ remote, name, group }, here) {
    const key = remoteKey(remote);
    if (!key) throw Object.assign(new Error('认不出这个仓库地址'), { status: 400 });
    // 没填名称 / 分组就保留原来的（加回移除过的项目时不丢设置）
    const patch = { hidden: undefined };
    if (name) patch.name = name;
    if (group) patch.group = group;
    const raw = updateProjectConfig(here, key, remote, patch);
    const conf = normalizeProject(raw);
    const i = this.cfg.projects.findIndex((p) => p.key === key);
    if (i >= 0) this.cfg.projects[i] = conf;
    else this.cfg.projects.push(conf);
    const existing = this.byKey.get(key);
    if (existing) {
      existing.conf = conf;
      existing.name = conf.name ?? key.split('/').pop();
    } else this.reconcile();
    this.emit('change', { id: null, what: 'projects' });
    return this.byKey.get(key)?.id ?? null;
  }

  /** 移除项目：只是在配置里标成隐藏，云端副本和你的仓库都不动。 */
  removeProject(id, here) {
    const p = this.get(id);
    if (!p) throw Object.assign(new Error('没有这个项目'), { status: 404 });
    const raw = updateProjectConfig(here, p.key, p.url, { hidden: true });
    const conf = normalizeProject(raw);
    const i = this.cfg.projects.findIndex((x) => x.key === p.key);
    if (i >= 0) this.cfg.projects[i] = conf;
    else this.cfg.projects.push(conf);
    this.reconcile();
    this.emit('change', { id: null, what: 'projects' });
  }
  get(id) {
    return this.projects.get(id) ?? null;
  }
  /**
   * 左侧栏拖动排序：items = [{ id, group }]，按这个顺序写回 config.json，项目列表（侧栏、看板）随之重排。
   * 没列到的项目排在后面、顺序不变。
   */
  reorder(items, here) {
    const list = [];
    for (const it of items) {
      const p = this.get(it.id);
      if (!p || list.some((x) => x.key === p.key)) continue;
      const group = typeof it.group === 'string' && it.group.trim() ? it.group.trim().slice(0, 20) : null;
      list.push({ key: p.key, remote: p.url, group, p });
    }
    const raw = reorderProjectsConfig(here, list);
    this.cfg.projects = raw.map((x, i) => normalizeProject(x, i));
    for (const { key, p } of list) p.conf = this.cfg.projects.find((x) => x.key === key) ?? p.conf;
    const order = [...list.map((x) => x.p), ...this.list().filter((p) => !list.some((x) => x.p === p))];
    this.projects = new Map(order.map((p) => [p.id, p]));
    this.emit('change', { id: null, what: 'projects' });
  }

  notify(project, what) {
    project.version++;
    this.emit('change', { id: project.id, what, version: project.version });
  }

  /** 后台：建副本、同步、探测、扫本机，各按各的节奏。 */
  start() {
    const loop = async () => {
      try {
        if (Date.now() - this.discoveredAt > DISCOVER_EVERY) {
          this.discoveredAt = Date.now();
          await this.scanner.discover().catch(() => {});
          const before = this.projects.size;
          this.reconcile();
          if (this.projects.size !== before) this.emit('change', { id: null, what: 'projects' });
        }
        await Promise.all(this.list().map((p) => p.tick().catch((e) => console.warn(`  ${p.id}：${firstLine(e)}`))));
      } finally {
        this.timer = setTimeout(loop, TICK);
      }
    };
    loop();
  }
}

export class Project {
  constructor(ws, { id, key, url, conf }) {
    this.ws = ws;
    this.id = id;
    this.key = key;
    this.url = url;
    this.conf = conf ?? {};
    this.version = 0;
    const repoName = key.split('/').pop();
    this.name = this.conf.name ?? repoName;
    this.mirror = new Mirror({ key, url, dir: join(ws.cfg.cacheDir, 'mirrors', key.replace(/[^a-z0-9._-]+/gi, '_') + '.git'), credentials: () => ws.github.gitEnv(githubSlug(url)) });
    this.repo = new Repo(repoName, this.mirror.dir, { accounts: ws.accounts, aliases: ws.cfg.people, github: ws.github }, { url, worktrees: () => this.graphWorktrees() });
    this.envs = (this.conf.environments ?? []).map((e) => new EnvProbe(e));
    this.deploys = new DeployLog(join(ws.cfg.cacheDir, 'deploys', key.replace(/[^a-z0-9._-]+/gi, '_') + '.json'));
    this.local = null;
    this.due = { sync: 0, probe: 0, local: 0 };
    this.booting = null;
    this.graphState = null; // { raw, G }
    this.snap = null; // { version, value }
    this.lastError = null;
  }

  get ready() {
    return this.mirror.ready;
  }

  /** 第一次：建副本（有本机仓库就先从本机拷）→ 读本机 → 探测环境 → 联网同步。 */
  boot() {
    if (this.booting) return this.booting;
    this.booting = (async () => {
      const fresh = !this.mirror.ready;
      if (fresh) {
        this.ws.notify(this, 'sync');
        await this.mirror.ensure(this.ws.scanner.seedsFor(this.key));
        this.ws.notify(this, 'cloud');
      }
      await this.refreshLocal();
      await this.probeEnvs();
      await this.sync();
    })().catch((e) => {
      this.lastError = firstLine(e);
      this.mirror.state.status = 'error';
      this.mirror.state.error = this.lastError;
      this.ws.notify(this, 'sync');
    });
    return this.booting;
  }

  async tick() {
    const now = Date.now();
    if (!this.booting) {
      this.due = { sync: now + this.ws.cfg.syncInterval * 1000, probe: now + this.ws.cfg.probeInterval * 1000, local: now + this.ws.cfg.localInterval * 1000 };
      return this.boot();
    }
    if (!this.mirror.ready) return;
    const jobs = [];
    if (now >= this.due.sync) {
      this.due.sync = now + this.mirror.nextDelay(this.ws.cfg.syncInterval * 1000);
      jobs.push(this.sync());
    }
    if (now >= this.due.probe) {
      this.due.probe = now + this.ws.cfg.probeInterval * 1000;
      jobs.push(this.probeEnvs());
    }
    if (now >= this.due.local) {
      this.due.local = now + this.ws.cfg.localInterval * 1000;
      jobs.push(this.refreshLocal());
    }
    await Promise.all(jobs);
  }

  /* ---------- 三份数据 ---------- */

  async sync() {
    if (!this.mirror.ready) return { changed: false };
    this.ws.notify(this, 'sync');
    const r = await this.mirror.sync();
    this.due.sync = Date.now() + this.mirror.nextDelay(this.ws.cfg.syncInterval * 1000);
    if (r.changed) {
      this.invalidate();
      this.ws.notify(this, 'cloud');
      // 云端变了：本机「推没推」和按标签找版本的环境都要重算
      await Promise.all([this.refreshLocal(), this.probeEnvs()]);
    } else this.ws.notify(this, 'sync');
    return r;
  }

  /**
   * 设置里的「测试」：对一个探测地址发一次只读 GET，带回状态、认出的提交、原因和返回内容的开头；不记录、不影响正在用的环境。
   * 已有环境用的是同一个地址时，沿用它的字段配置（commit / version / resolve）。
   */
  async testProbe(url) {
    const conf = (this.conf.environments ?? []).find((e) => e.probe?.url === url);
    const probe = new EnvProbe(conf ?? normalizeEnv({ name: '测试', probe: { url } }, 0, this.conf));
    const G = this.mirror.ready ? await this.graph().catch(() => null) : null;
    const r = await probe.probeOnce({ tags: G?.tagShas() ?? new Map(), checkoutPaths: this.ws.scanner.checkoutPaths(this.key) }, { sample: true });
    const i = r.commit && G ? G.resolve(r.commit) : -1;
    return { ...r, inRepo: r.commit ? i >= 0 : null, subject: i >= 0 ? G.s[i] : null, short: i >= 0 ? G.h[i].slice(0, 7) : r.commit?.slice(0, 7) ?? null };
  }

  async probeEnvs() {
    if (!this.envs.length) return;
    const ctx = { tags: this.graphState?.G.tagShas() ?? new Map(), checkoutPaths: this.ws.scanner.checkoutPaths(this.key) };
    if (!this.graphState && this.mirror.ready) {
      const G = await this.graph().catch(() => null);
      if (G) ctx.tags = G.tagShas();
    }
    const changed = await Promise.all(this.envs.map((e) => e.probe(ctx).catch(() => false)));
    // 换了提交就记一条上线记录（短提交号尽量换成完整的）
    const G = this.graphState?.G;
    for (const e of this.envs) {
      const r = e.result;
      if (r.state !== 'up' || !r.commit) continue;
      const i = G ? G.resolve(r.commit) : -1;
      if (this.deploys.record(e.env.id, i >= 0 ? G.h[i] : r.commit, r.version)) changed.push(true);
    }
    if (changed.some(Boolean)) {
      this.snap = null;
      this.ws.notify(this, 'env');
    }
  }

  async refreshLocal() {
    const G = this.mirror.ready ? await this.graph().catch(() => null) : null;
    const next = await this.ws.scanner.status(this.key, G);
    const sig = (s) => JSON.stringify([s.checkouts.map((c) => [c.path, c.branch, c.head, c.total, c.cloud?.behind, c.cloud?.unpushed]), s.branches.map((b) => [b.name, b.sha, b.unpushed, b.behind]), s.stashes]);
    const changed = !this.local || sig(this.local) !== sig(next);
    const graphChanged = !this.local || JSON.stringify(this.graphWorktrees(this.local)) !== JSON.stringify(this.graphWorktrees(next));
    this.local = next;
    this.due.local = Date.now() + this.ws.cfg.localInterval * 1000;
    if (graphChanged) this.invalidate();
    if (changed) {
      this.snap = null;
      this.ws.notify(this, 'local');
    }
  }

  /** 提交图上要标出来的本机工作树。 */
  graphWorktrees(local = this.local) {
    return (local?.checkouts ?? []).filter((c) => !c.missing && c.head).map((c) => ({ id: c.id, path: c.path, head: c.head, branch: c.branch, detached: c.detached, temp: c.temp }));
  }

  invalidate() {
    this.graphState = null;
    this.snap = null;
  }

  async graph() {
    if (!this.mirror.ready) throw Object.assign(new Error('云端副本还在准备中'), { status: 503 });
    const raw = await this.repo.graph();
    if (this.graphState?.raw !== raw) this.graphState = { raw, G: new CommitGraph(raw) };
    return this.graphState.G;
  }

  /** 给提交图页面用的完整图数据，外加各环境运行的提交。 */
  async graphData() {
    const G = await this.graph();
    const flow = detectFlow(G, this.conf.flow);
    return {
      ...G.raw,
      trunk: { prod: flow.at(-1) ?? G.raw.trunk.prod, dev: flow.length > 1 ? flow[0] : null },
      envs: this.envs.map((e) => {
        const r = e.result;
        const known = r.commit && G.resolve(r.commit) >= 0;
        // 没配探测（或读不出）的标签：先挂在它的分支最新提交上，标成「假定」
        const tip = e.env.branch ? G.branchTip(e.env.branch) : -1;
        return {
          id: e.env.id,
          name: e.env.name,
          branch: e.env.branch,
          probe: e.env.probe?.url ?? null,
          commit: known ? r.commit : tip >= 0 ? G.h[tip] : null,
          assumed: !known,
          version: r.version ?? null,
          state: r.state,
          detail: r.error ?? r.detail ?? null,
          checkedAt: r.checkedAt ?? null,
        };
      }),
      project: this.id,
    };
  }

  /**
   * 页面上给分支加 / 改 / 删环境标签：写回 config.json，马上生效。
   * list: [{ id?, name, branch, probe? }]（probe 是健康接口地址，可留空）
   */
  async setEnvironments(list, here) {
    const raw = list.map((e) => {
      const old = (this.conf.environments ?? []).find((x) => x.id === e.id);
      const probeUrl = typeof e.probe === 'string' ? e.probe.trim() : e.probe?.url ?? null;
      const base = old ? { name: old.name, branch: old.branch, url: old.url, kind: old.kind, note: old.note, resolve: old.resolve?.length ? old.resolve : undefined, probe: old.probe } : {};
      const probe = probeUrl ? { ...(old?.probe?.url === probeUrl ? old.probe : {}), url: probeUrl } : null;
      return JSON.parse(JSON.stringify({ ...base, name: e.name.trim(), branch: e.branch ?? base.branch ?? null, probe }));
    });
    saveEnvironments(here, this.key, this.url, raw);
    this.conf.environments = raw.map((e, j) => normalizeEnv(e, j, this.conf));
    this.envs = this.conf.environments.map((e) => new EnvProbe(e));
    this.invalidate();
    this.ws.notify(this, 'env');
    await this.probeEnvs();
    this.ws.notify(this, 'env');
  }

  /**
   * 项目设置：主线（flow，按流向，如 ['dev', 'main']；最后一条是上线分支）和环境，一起写回 config.json。
   * flow 传空数组表示「自动识别」。
   */
  async setSettings({ flow, environments }, here) {
    if (flow !== undefined) {
      const f = flow?.length ? flow : undefined;
      updateProjectConfig(here, this.key, this.url, { flow: f });
      this.conf.flow = f ?? null;
      this.invalidate();
    }
    if (environments) await this.setEnvironments(environments, here);
    this.ws.notify(this, 'cloud');
  }

  /** 给一条分支打自定义标签（发布候选、阻塞……），写回 config.json。tags 为空就删掉。 */
  setBranchTags(branch, tags, here) {
    const all = { ...(this.conf.branchTags ?? {}) };
    if (tags.length) all[branch] = tags;
    else delete all[branch];
    updateProjectConfig(here, this.key, this.url, { branchTags: Object.keys(all).length ? all : undefined });
    this.conf.branchTags = all;
    this.snap = null;
    this.ws.notify(this, 'tags');
  }

  /* ---------- 快照 ---------- */

  async snapshot() {
    if (this.snap?.version === this.version && this.snap.value) return this.snap.value;
    const version = this.version;
    const base = this.meta();
    if (!this.mirror.ready) {
      const value = { ...base, ready: false, sync: this.syncState(), health: [] };
      return value;
    }
    const G = await this.graph();
    const flow = detectFlow(G, this.conf.flow);
    // PR：有缓存就用，没有就后台去拿，拿到了再通知页面
    const prs = this.repo.prCache?.value;
    if (!prs || Date.now() - this.repo.prCache.at > 5 * 60 * 1000) {
      this.repo.prs().then((v) => {
        if (v !== prs && v.available) {
          this.snap = null;
          this.ws.notify(this, 'prs');
        }
      }).catch(() => {});
    }
    const a = analyze({
      G,
      flow,
      envs: this.envs.map((e) => ({ ...e.env, result: e.result })),
      prs: prs?.available ? prs.list : null,
      tickets: this.conf.tickets ?? this.ws.cfg.tickets,
      windowDays: this.ws.cfg.windowDays,
      staleDays: this.ws.cfg.health.staleDays,
    });
    const sync = this.syncState();
    const now = Math.floor(Date.now() / 1000);
    const health = check({ a, sync, local: this.local, now, cfg: this.ws.cfg });
    const { pack, ...analysis } = a;
    const value = {
      ...base,
      ready: true,
      generatedAt: now,
      sync,
      prs: prs ? { available: prs.available, reason: prs.reason ?? null } : { available: null },
      persons: G.people.map((p, id) => ({ id, name: p.name, names: p.names, avatar: p.avatar, login: p.login, commits: p.commits })),
      ...analysis,
      deploys: this.deployRows(G, pack),
      health,
      local: this.localSummary(),
      branchTags: this.conf.branchTags ?? {},
      configured: { envs: this.envs.length, flow: !!this.conf.flow },
    };
    this.snap = { version, value };
    return value;
  }

  /** 上线记录（新的在前），每条算出这次带上了哪些提交、工单；回退的也算出来。 */
  deployRows(G, pack) {
    const perEnv = new Map();
    const out = [];
    for (let i = this.deploys.list.length - 1; i >= 0; i--) {
      const d = this.deploys.list[i];
      const n = perEnv.get(d.env) ?? 0;
      if (n >= 30) continue;
      perEnv.set(d.env, n + 1);
      const to = G.resolve(d.to);
      const from = d.from ? G.resolve(d.from) : -1;
      const row = { ...d, known: to >= 0 };
      if (to >= 0 && from >= 0) {
        const noMerge = (list) => list.filter((c) => !G.isMerge(c));
        const added = pack(noMerge(G.listDiff(G.anc(to), G.anc(from))));
        added.commits = added.commits.slice(0, 60);
        row.added = added;
        row.removed = noMerge(G.listDiff(G.anc(from), G.anc(to))).length;
      }
      out.push(row);
    }
    return out;
  }

  meta() {
    return {
      id: this.id,
      key: this.key,
      name: this.name,
      group: this.conf.group ?? null,
      description: this.conf.description ?? null,
      remote: this.url,
      slug: githubSlug(this.url),
      web: webUrl(this.url),
      inConfig: !!this.conf.key,
    };
  }

  syncState() {
    const s = this.mirror.state;
    return { status: s.status, lastOk: s.lastOk, lastAttempt: s.lastAttempt, lastChange: s.lastChange, error: s.error, next: this.due.sync || null };
  }

  localSummary() {
    const L = this.local;
    if (!L) return null;
    const checkouts = L.checkouts.map(({ files, ...c }) => c);
    const branches = L.branches; // 全部本机分支：分支页的「本机」筛选要用
    return {
      scannedAt: L.scannedAt,
      repos: L.repos,
      checkouts,
      branches,
      stashes: L.stashes,
      counts: {
        unpushedBranches: L.branches.filter((b) => b.unpushed > 0).length,
        unpushedCommits: L.branches.reduce((s, b) => s + (b.unpushed > 0 ? b.unpushed : 0), 0),
        behind: L.checkouts.filter((c) => !c.temp && c.cloud?.behind > 0).length,
        dirty: L.checkouts.filter((c) => !c.temp && !c.missing && c.total > 0).length,
        checkouts: L.checkouts.filter((c) => !c.missing).length,
      },
    };
  }

  /** 首页一行用的概况。 */
  async summary() {
    const base = this.meta();
    if (!this.mirror.ready) return { ...base, ready: false, sync: this.syncState() };
    let s;
    try {
      s = await this.snapshot();
    } catch (e) {
      return { ...base, ready: false, sync: this.syncState(), error: firstLine(e) };
    }
    const lastBranch = s.branches[0];
    const trunkTips = s.stages.filter((x) => x.kind === 'branch' && x.tip).map((x) => x.tip);
    const latest = [...trunkTips, ...(lastBranch ? [lastBranch.tip] : [])].sort((x, y) => y.ctime - x.ctime)[0] ?? null;
    const lvl = (l) => s.health.filter((h) => h.level === l).length;
    return {
      ...base,
      ready: true,
      sync: s.sync,
      stages: s.stages.map((x) => ({ key: x.key, kind: x.kind, name: x.name, known: x.known, state: x.kind === 'env' ? x.result.state : null, short: x.tip?.short ?? null, version: x.kind === 'env' ? x.result.version ?? null : null })),
      gaps: s.gaps.map((g) => ({ from: g.from, pending: g.pending, reverse: g.reverse })),
      trunk: s.trunk ? { dev: s.trunk.dev, main: s.trunk.main, ahead: s.trunk.ahead.count, behind: s.trunk.behind.count, oldest: s.trunk.ahead.oldest } : null,
      inFlight: s.items.filter((i) => i.seg < s.doneSeg || !s.doneSeg).length,
      activeBranches: s.branches.filter((b) => b.status === 'active').length,
      activePeople: s.people.filter((p) => !p.bot && p.d7 > 0).map((p) => p.id).slice(0, 8),
      persons: s.persons,
      latest: latest ? { ...latest, name: s.persons[latest.author]?.name } : null,
      health: { critical: lvl('critical'), warning: lvl('warning'), info: lvl('info'), top: s.health.filter((h) => h.level !== 'info').slice(0, 2).map((h) => ({ level: h.level, title: h.title })) },
      local: s.local?.counts ?? null,
      envCount: this.envs.length,
    };
  }

  /** 看板用：概况 + 全部健康信号 + 活跃的人和分支 + 本机没推送的分支。 */
  async board() {
    const sum = await this.summary();
    if (!sum.ready) return sum;
    const s = await this.snapshot();
    const active = s.branches.filter((b) => b.status === 'active');
    // 看板的线路图：进行中的分支（汇入集成分支）、已进集成分支等上线的分支（dev → main 那段）
    const unpushedBy = new Map((s.local?.branches ?? []).filter((b) => b.unpushed > 0).map((b) => [b.cloudName ?? b.name, b.unpushed]));
    const lane = (b) => ({ name: b.name, owner: b.owner, own: b.own, behind: b.behind, time: b.time, unpushed: unpushedBy.get(b.name) ?? 0, pr: b.pr ? { n: b.pr.n, title: b.pr.title, state: b.pr.state, url: b.pr.url, review: b.pr.review ?? null, ci: b.pr.ci ?? null } : null });
    return {
      ...sum,
      trunk: { ...(sum.trunk ?? {}), main: s.flow.at(-1) ?? null, dev: s.flow.length > 1 ? s.flow[0] : null, aheadPeople: s.trunk?.ahead.people ?? [], behindPeople: s.trunk?.behind.people ?? [] },
      lanes: {
        active: active.slice(0, 40).map(lane),
        waiting: s.branches.filter((b) => b.status === 'merged').slice(0, 30).map(lane),
        stale: s.branches.filter((b) => b.status === 'stale').length,
      },
      envs: s.stages.filter((x) => x.kind === 'env').concat(s.extraEnvs).map((x) => ({ id: x.envId, name: x.name, branch: x.branch, state: x.result?.state, known: x.known, behind: x.behindBranch ?? null, skip: x.skipCount ?? 0, short: x.tip?.short ?? null, sha: x.tip?.sha ?? null, version: x.result?.version ?? null, via: x.result?.resolvedBy?.kind ?? null, detail: x.result?.detail ?? x.result?.error ?? null, probe: !!x.probeUrl })),
      signals: s.health.map((h) => ({ level: h.level, title: h.title, detail: h.detail ?? null, link: h.link ?? null })),
      people: s.people.filter((p) => !p.bot).map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, last: p.last, d7: p.d7, branches: active.filter((b) => b.owner === p.id).map((b) => ({ name: b.name, own: b.own, time: b.time })) })),
      unpushed: (s.local?.branches ?? []).filter((b) => b.unpushed > 0).map((b) => ({ name: b.name, unpushed: b.unpushed, time: b.time })),
      dirty: (s.local?.checkouts ?? []).filter((c) => !c.temp && !c.missing && c.total > 0).map((c) => ({ name: c.name, branch: c.branch, total: c.total })),
    };
  }

  /* ---------- 本机工作树（提交图的「未提交改动」和本机页用） ---------- */
  checkout(id) {
    const c = this.local?.checkouts.find((x) => x.id === Number(id));
    if (!c || c.missing) throw Object.assign(new Error('没有这个工作区'), { status: 404 });
    return c;
  }
}

export { remoteKey };
