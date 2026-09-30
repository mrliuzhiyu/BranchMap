// 配置：config.json（不进仓库）。什么都不写也能用——扫描目录里的仓库按远程地址自动归成项目，
// 主线分支自动识别；环境（服务器 / 发布渠道）需要写一次它们在哪、怎么读出当前版本。
// 格式见 config.example.json 与 README。
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { remoteKey } from './remote.mjs';
import { authConfig } from './auth.mjs';

const readJson = (f) => {
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch (e) {
    throw new Error(`${f} 不是合法的 JSON：${e.message}`);
  }
};

export const DEFAULTS = {
  port: 4317,
  // 云端副本多久同步一次（秒）
  syncInterval: 120,
  // 环境多久探测一次（秒）
  probeInterval: 60,
  // 本机工作区多久重读一次（秒）；切回页面时也会读
  localInterval: 90,
  // 在途工作的时间窗：这么多天内有动静的都列出来（还没上线的不受限）
  windowDays: 21,
  health: {
    // 分支超过这么多天没动、也没合进主线，算停滞
    staleDays: 30,
    // 待上线的最早一个提交等了这么多天，提示发布积压
    backlogDays: 7,
    // 环境落后它的分支、且落后的改动已经等了这么多小时，提示该部署了
    envLagHours: 24,
  },
};

/** 读配置；argv 里的 --root= / --port= 覆盖文件里的同名设置。 */
export function loadConfig(here, argv = process.argv) {
  const arg = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const file = readJson(join(here, 'config.json')) ?? {};
  const legacyAliases = readJson(join(here, 'aliases.json')) ?? {};

  const scan = [arg('root') ?? file.scan ?? file.root].flat().filter(Boolean).map((r) => resolve(r));
  const extraRepos = (file.repos ?? []).map((r) => resolve(r));
  const people = { ...legacyAliases, ...(file.people ?? {}) };

  const projects = (file.projects ?? []).map((p, i) => normalizeProject(p, i));

  // 旧版的 trunk: { 仓库名: { prod, dev } }
  const legacyTrunk = file.trunk ?? {};

  return {
    port: Number(arg('port') ?? file.port ?? DEFAULTS.port),
    scan,
    extraRepos,
    people,
    projects,
    legacyTrunk,
    syncInterval: Math.max(30, Number(file.syncInterval ?? DEFAULTS.syncInterval)),
    probeInterval: Math.max(15, Number(file.probeInterval ?? DEFAULTS.probeInterval)),
    localInterval: Math.max(20, Number(file.localInterval ?? DEFAULTS.localInterval)),
    windowDays: Number(file.windowDays ?? DEFAULTS.windowDays),
    health: { ...DEFAULTS.health, ...(file.health ?? {}) },
    tickets: file.tickets ?? null,
    cacheDir: resolve(here, file.cacheDir ?? '.cache'),
    // 部署到服务器时的公司飞书门禁（lib/auth.mjs）；本机不写 = 不开
    auth: authConfig(file),
  };
}

/** 配置文件里的一个项目 → 程序里用的形状。 */
export function normalizeProject(p, i = 0) {
  const key = remoteKey(p.remote);
  if (!key) throw new Error(`config.json 的 projects[${i}] 缺少合法的 remote（仓库地址）`);
  return {
    key,
    remote: p.remote,
    id: p.id ?? null,
    name: p.name ?? null,
    group: p.group ?? null,
    description: p.description ?? null,
    hidden: !!p.hidden,
    flow: p.flow ?? null,
    environments: (p.environments ?? []).map((e, j) => normalizeEnv(e, j, p)),
    tickets: p.tickets ?? null,
    branchTags: p.branchTags ?? {},
  };
}

/**
 * 改 config.json 里的一个项目（按仓库地址对上），其余配置原样保留；还没有这个项目就加一条。
 * patch 里值为 undefined 的字段会被删掉。返回改完的那条原始配置。
 */
export function updateProjectConfig(here, key, remote, patch) {
  const file = join(here, 'config.json');
  const data = readJson(file) ?? {};
  data.projects ??= [];
  let p = data.projects.find((x) => remoteKey(x.remote) === key);
  if (!p) data.projects.push((p = { remote }));
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete p[k];
    else p[k] = v;
  }
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return p;
}

/**
 * 按给定顺序重排 config.json 里的项目（左侧栏拖动排序），顺带改分组。
 * list: [{ key, remote, group }]，group 为 null 表示不分组；没列到的项目（比如移除过的）按原顺序排在后面。
 */
export function reorderProjectsConfig(here, list) {
  const file = join(here, 'config.json');
  const data = readJson(file) ?? {};
  const old = data.projects ?? [];
  const byKey = new Map(old.map((x) => [remoteKey(x.remote), x]));
  const out = [];
  for (const { key, remote, group } of list) {
    const p = byKey.get(key) ?? { remote };
    byKey.delete(key);
    if (group) p.group = group;
    else delete p.group;
    out.push(p);
  }
  data.projects = [...out, ...old.filter((x) => byKey.has(remoteKey(x.remote)))];
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return data.projects;
}

/** 把一个项目的环境（分支上的「生产」「测试」这类标签）写回 config.json。 */
export function saveEnvironments(here, key, remote, environments) {
  return updateProjectConfig(here, key, remote, { environments });
}

export function normalizeEnv(e, j, p) {
  const name = e.name ?? `环境 ${j + 1}`;
  const probe = typeof e.probe === 'string' ? { url: e.probe } : e.probe ?? null;
  return {
    id: e.id ?? slug(name, j),
    name,
    branch: e.branch ?? null,
    url: e.url ?? null,
    probe: probe && probe.url ? {
      url: probe.url,
      commit: probe.commit ?? null,
      version: probe.version ?? null,
      headers: probe.headers ?? null,
      timeout: Number(probe.timeout ?? 15000),
    } : null,
    resolve: [e.resolve ?? []].flat(),
    kind: e.kind ?? (p.kind === 'client' ? 'channel' : 'server'),
    note: e.note ?? null,
  };
}

function slug(name, j) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return s || `env${j + 1}`;
}
