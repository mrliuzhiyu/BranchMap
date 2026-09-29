// 健康检查：每条规则是一个纯函数，读项目快照，返回零到多条信号。
// 信号 { id, level: 'critical' | 'warning' | 'info', title, detail?, link? }
//   link：点它跳到哪，页面按它导航：
//     { view: 'graph', c: 提交号 }        分支图，选中这个提交
//     { view: 'graph', env: 环境, t: 'pending' | 'next' | 'skip' | 'log' }   分支图，打开环境详情的某个标签页
//     { view: 'graph', b: 分支, t: 'ahead' | 'behind' }   分支图，打开这条分支（主线的「待上线 / 没回合」）
//     { view: 'branches', f: 筛选 }      分支页的某个筛选
//     { view: 'settings' }               项目设置（环境读不出版本时去填探测地址）
// 想加规则就往 RULES 里加一个函数。
const H = 3600;
const DAY = 86400;

const ago = (t, now) => {
  const s = now - t;
  if (s < H) return `${Math.max(1, Math.round(s / 60))} 分钟`;
  if (s < DAY) return `${Math.round(s / H)} 小时`;
  return `${Math.round(s / DAY)} 天`;
};

export const RULES = [
  // 云端副本同步失败
  function sync({ sync, now }) {
    if (sync.status === 'missing' || sync.status === 'cloning') return [];
    if (sync.status === 'error' && !sync.lastOk) return [{ id: 'sync.never', level: 'critical', title: '还没能从远程同步过', detail: sync.error }];
    if (sync.status === 'error' && sync.lastOk && now - sync.lastOk / 1000 > 15 * 60) {
      return [{ id: 'sync.failed', level: 'warning', title: `云端同步失败，数据停在 ${ago(sync.lastOk / 1000, now)}前`, detail: sync.error }];
    }
    return [];
  },

  // 环境：连不上 / 读不出版本 / 跑的提交不在云端
  function envState({ a }) {
    const out = [];
    for (const s of [...a.stages, ...a.extraEnvs]) {
      if (s.kind !== 'env') continue;
      const r = s.result;
      if (r.state === 'down' && s.envKind === 'local') out.push({ id: `env.local.${s.envId}`, level: 'info', title: `${s.name}：这台电脑上没在运行`, detail: r.error });
      else if (r.state === 'down') out.push({ id: `env.down.${s.envId}`, level: 'critical', title: `${s.name}连不上`, detail: `${r.error ?? ''}${r.lastKnown ? `；上次读到的版本是 ${r.lastKnown.version ?? r.lastKnown.commit.slice(0, 7)}` : ''}`, link: { view: 'settings' } });
      else if (s.foreign) out.push({ id: `env.foreign.${s.envId}`, level: 'warning', title: `${s.name}运行的提交 ${r.commit.slice(0, 7)} 不在云端任何分支里`, detail: '可能是用没推送的本地代码部署的，或者云端副本还没同步到' });
      else if (r.state === 'up' && !s.known) out.push({ id: `env.unknown.${s.envId}`, level: 'info', title: `${s.name}读不出运行的是哪个提交`, detail: r.detail ?? '接口没有返回提交号', link: { view: 'settings' } });
    }
    return out;
  },

  // 环境没跟上它的分支（只数带改动的提交）
  function envLag({ a, now, cfg }) {
    const out = [];
    for (const s of a.stages) {
      if (s.kind !== 'env' || !s.known || !s.branch || !s.behindBranch) continue;
      const waited = s.waitingSince ? now - s.waitingSince : 0;
      const level = waited > cfg.health.envLagHours * H ? 'warning' : 'info';
      const how = s.result.resolvedBy?.kind === 'manifest' ? `版本 ${s.result.version} → ${s.tip.short}（本机打包清单）` : s.result.resolvedBy?.kind === 'tag' ? `版本 ${s.result.version} → ${s.tip.short}（标签 ${s.result.resolvedBy.tag}）` : `运行 ${s.tip.short}`;
      out.push({ id: `env.lag.${s.envId}`, level, title: `${s.name}落后 ${s.branch} ${s.behindBranch} 个提交`, detail: `${how}${s.waitingSince ? `；最早一个已经等了 ${ago(s.waitingSince, now)}` : ''}`, link: { view: 'graph', env: s.envId, t: 'pending' } });
    }
    return out;
  },

  // 环境跑的代码不在它的分支上（从别处部署的）
  function envOffBranch({ a }) {
    const out = [];
    for (const s of a.stages) {
      if (s.kind !== 'env' || !s.known || !s.branch || !s.offBranch) continue;
      out.push({ id: `env.off.${s.envId}`, level: 'warning', title: `${s.name}运行的代码里有 ${s.offBranch} 个提交不在 ${s.branch} 上`, detail: `它可能是从别的分支部署的（运行 ${s.tip.short}）`, link: { view: 'graph', c: s.tip.sha } });
    }
    return out;
  },

  // 顺序反了：合进上线分支时前一个环境还没部署；后一个环境比前一个新（跳过了测试）
  function reverse({ a }) {
    const out = [];
    const laterEnv = (i) => a.stages.slice(i + 1).some((s) => s.kind === 'env' && s.known);
    for (const g of a.gaps) {
      if (!g.reverse) continue;
      const from = a.stages[g.from];
      const to = a.stages[g.to];
      if (from.kind !== 'env' || to.kind !== 'branch' || laterEnv(g.to)) continue;
      out.push({ id: `rev.${g.from}.${g.to}`, level: 'warning', title: `${to.name} 上有 ${g.reverse} 个提交没在${from.name}验证过`, detail: `合进 ${to.name} 时，${from.name}还没部署它们`, link: { view: 'graph', c: g.reverseSample[0]?.sha } });
    }
    const envs = a.stages.filter((s) => s.kind === 'env' && s.known);
    for (let k = 1; k < envs.length; k++) {
      const e1 = envs[k - 1];
      const e2 = envs[k];
      if (e2.skipCount) out.push({ id: `skip.${e1.envId}.${e2.envId}`, level: 'warning', title: `${e2.name}有 ${e2.skipCount} 个提交${e1.name}没有`, detail: `${e2.name}比${e1.name}还新：这些改动没经过${e1.name}就上了${e2.name}`, link: { view: 'graph', env: e2.envId, t: 'skip' } });
    }
    return out;
  },

  // 两条主线直接比：待上线积压、没回合
  function trunk({ a, now, cfg }) {
    const t = a.trunk;
    if (!t) return [];
    const out = [];
    if (t.ahead.count) {
      const waited = t.ahead.oldest ? now - t.ahead.oldest : 0;
      out.push({ id: 'trunk.ahead', level: waited > cfg.health.backlogDays * DAY ? 'warning' : 'info', title: `${t.ahead.count} 个提交在 ${t.dev}、还没进 ${t.main}`, detail: `待上线，涉及 ${t.ahead.people.length} 个成员${t.ahead.oldest ? `；最早一个等了 ${ago(t.ahead.oldest, now)}` : ''}`, link: { view: 'graph', b: t.dev, t: 'ahead' } });
    }
    if (t.behind.count) {
      out.push({ id: 'trunk.behind', level: 'warning', title: `${t.main} 上有 ${t.behind.count} 个提交没回合到 ${t.dev}`, detail: `直接改在 ${t.main} 上的代码，下次从 ${t.dev} 合过去时可能冲突或被覆盖`, link: { view: 'graph', b: t.main, t: 'behind' } });
    }
    return out;
  },

  // 停滞的分支
  function stale({ a, cfg }) {
    const list = a.branches.filter((b) => b.status === 'stale');
    if (!list.length) return [];
    return [{ id: 'branch.stale', level: 'info', title: `${list.length} 条分支超过 ${cfg.health.staleDays} 天没动，也没合进主线`, detail: list.slice(0, 4).map((b) => b.name).join('、') + (list.length > 4 ? ' 等' : ''), link: { view: 'branches', f: 'stale' } }];
  },

  // 本机的情况（没推送、没提交……）不算项目的健康，在「分支」页的本机筛选和侧栏里单独看
];

const ORDER = { critical: 0, warning: 1, info: 2 };

/** 跑全部规则。 */
export function check(snapshot) {
  const out = [];
  for (const rule of RULES) {
    try {
      out.push(...rule(snapshot));
    } catch (e) {
      out.push({ id: `rule.${rule.name}`, level: 'info', title: `检查「${rule.name}」出错`, detail: e.message });
    }
  }
  return out.sort((x, y) => ORDER[x.level] - ORDER[y.level]);
}
