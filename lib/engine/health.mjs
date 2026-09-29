// 健康检查：每条规则是一个纯函数，读项目快照，返回零到多条信号。
// 信号 { id, level: 'critical' | 'warning' | 'info', title, detail?, link? }
//   link：页面上点它跳到哪（{ view, params }），比如在途列表的某一段、本机页。
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

  // 环境：宕机 / 读不到版本 / 版本不在云端
  function envState({ a }) {
    const out = [];
    for (const s of [...a.stages, ...a.extraEnvs]) {
      if (s.kind !== 'env') continue;
      const r = s.result;
      if (r.state === 'down' && s.envKind === 'local') out.push({ id: `env.local.${s.envId}`, level: 'info', title: `${s.name}：这台电脑上没在运行`, detail: r.error, link: { env: s.envId } });
      else if (r.state === 'down') out.push({ id: `env.down.${s.envId}`, level: 'critical', title: `${s.name}连不上`, detail: `${r.error ?? ''}${r.lastKnown ? `；上次读到的版本是 ${r.lastKnown.version ?? r.lastKnown.commit.slice(0, 7)}` : ''}`, link: { env: s.envId } });
      else if (s.foreign) out.push({ id: `env.foreign.${s.envId}`, level: 'warning', title: `${s.name}运行的提交 ${r.commit.slice(0, 7)} 不在云端任何分支里`, detail: '可能是用没推送的本地代码部署的，或者云端副本还没同步到', link: { env: s.envId } });
      else if (r.state === 'up' && !s.known) out.push({ id: `env.unknown.${s.envId}`, level: 'info', title: `${s.name}读不出运行的是哪个提交`, detail: r.detail ?? '接口没有返回提交号', link: { env: s.envId } });
    }
    return out;
  },

  // 环境没跟上它的分支
  function envLag({ a, now, cfg }) {
    const out = [];
    for (const s of a.stages) {
      if (s.kind !== 'env' || !s.known || !s.branch || !s.behindBranch) continue;
      const waited = s.waitingSince ? now - s.waitingSince : 0;
      const level = waited > cfg.health.envLagHours * H ? 'warning' : 'info';
      out.push({ id: `env.lag.${s.envId}`, level, title: `${s.name}落后 ${s.branch} ${s.behindBranch} 个提交`, detail: s.waitingSince ? `最早一个已经等了 ${ago(s.waitingSince, now)}` : null, link: { seg: segOfStage(a, s.key) } });
    }
    return out;
  },

  // 环境跑的代码不在它的分支上（从别处部署的）
  function envOffBranch({ a }) {
    const out = [];
    for (const s of a.stages) {
      if (s.kind !== 'env' || !s.known || !s.branch || !s.offBranch) continue;
      out.push({ id: `env.off.${s.envId}`, level: 'warning', title: `${s.name}运行的代码里有 ${s.offBranch} 个提交不在 ${s.branch} 上`, detail: `它可能是从别的分支部署的（运行 ${s.tip.short}）` });
    }
    return out;
  },

  // 后一站有前一站没有的东西：跳过了测试、main 没回合到 dev
  function reverse({ a }) {
    const out = [];
    const laterEnv = (i) => a.stages.slice(i + 1).some((s) => s.kind === 'env' && s.known);
    for (const g of a.gaps) {
      if (!g.reverse) continue;
      const from = a.stages[g.from];
      const to = a.stages[g.to];
      let title;
      let detail = null;
      if (to.kind === 'env' && from.kind === 'branch' && to.branch === from.name) continue; // envOffBranch 已经说了
      if (from.kind === 'branch' && to.kind === 'branch') {
        title = `${to.name} 上有 ${g.reverse} 个提交没回合到 ${from.name}`;
        detail = `直接改在 ${to.name} 上的代码，下次从 ${from.name} 合过去时可能冲突或被覆盖`;
      } else if (from.kind === 'env' && to.kind === 'branch') {
        if (laterEnv(g.to)) continue; // 下面「环境比环境新」会说
        title = `${to.name} 上有 ${g.reverse} 个提交没在${from.name}验证过`;
        detail = `合进 ${to.name} 时，${from.name}还没部署它们`;
      } else {
        title = `${to.name}有 ${g.reverse} 个提交是${from.kind === 'env' ? from.name : ' ' + from.name + ' '}没有的`;
      }
      out.push({ id: `rev.${g.from}.${g.to}`, level: 'warning', title, detail, sample: g.reverseSample });
    }
    // 两个环境之间（中间隔着分支）：后一个环境有、前一个环境没有
    const envs = a.stages.map((s, i) => [s, i]).filter(([s]) => s.kind === 'env' && s.known);
    for (let k = 1; k < envs.length; k++) {
      const [e1] = envs[k - 1];
      const [e2] = envs[k];
      if (e2.skipCount) out.push({ id: `skip.${e1.envId}.${e2.envId}`, level: 'warning', title: `${e2.name}有 ${e2.skipCount} 个提交${e1.name}没有`, detail: `${e2.name}比${e1.name}还新：这些改动没经过${e1.name}就上了${e2.name}`, sample: e2.skipSample });
    }
    return out;
  },

  // 待上线积压
  function backlog({ a, now, cfg }) {
    const out = [];
    for (const g of a.gaps) {
      const from = a.stages[g.from];
      const to = a.stages[g.to];
      if (from.kind !== 'branch' || to.kind !== 'branch' || !g.pending) continue;
      const waited = g.oldest ? now - g.oldest : 0;
      const level = waited > cfg.health.backlogDays * DAY ? 'warning' : 'info';
      out.push({ id: `backlog.${to.name}`, level, title: `${g.pending} 个提交在 ${from.name}、还没进 ${to.name}`, detail: g.oldest ? `最早一个等了 ${ago(g.oldest, now)}` : null, link: { seg: g.to } });
    }
    return out;
  },

  // 停滞的分支
  function stale({ a, cfg }) {
    const list = a.branches.filter((b) => b.status === 'stale');
    if (!list.length) return [];
    return [{ id: 'branch.stale', level: 'info', title: `${list.length} 条分支超过 ${cfg.health.staleDays} 天没动，也没合进主线`, detail: list.slice(0, 4).map((b) => b.name).join('、') + (list.length > 4 ? ' 等' : ''), link: { view: 'people' } }];
  },

  // 本机的情况（没推送、没提交……）不算项目的健康，在「本机」页和侧栏里单独看
];

function segOfStage(a, key) {
  const i = a.stages.findIndex((s) => s.key === key);
  return i < 0 ? null : i;
}

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
