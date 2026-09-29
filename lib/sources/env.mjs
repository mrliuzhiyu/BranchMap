// 环境：一台服务器、一个发布渠道——任何「现在跑的是哪个提交」能被读出来的地方。
// 只发只读的 HTTP GET。读法按配置：
//   probe.commit   接口直接返回提交号（JSON 字段路径，如 "commit"、"build.sha"）
//   probe.version  接口只返回版本号，再按 resolve 里的规则找到提交：
//     { "tag": "dash-{version}" }                          云端的标签
//     { "manifest": "release/*/{version}/**/*.json", "field": "commit" }   本机打包留下的清单文件
// 没有 probe 的环境只显示「未配置探测」，不影响别的功能。
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const UA = 'BranchMap (read-only status probe)';

export class EnvProbe {
  constructor(env) {
    this.env = env;
    this.result = env.probe ? { state: 'pending' } : { state: 'unconfigured' };
    this.running = null;
    this.failures = 0;
  }

  /** 探一次。ctx: { tags: Map<标签名, 提交号>, checkoutPaths: string[] }。返回 true 表示结果变了。 */
  probe(ctx) {
    if (!this.env.probe) return Promise.resolve(false);
    if (this.running) return this.running;
    this.running = this.doProbe(ctx).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async doProbe(ctx) {
    // 网络偶尔慢一下：超时或连不上时隔两秒再试一次
    let r = await this.probeOnce(ctx);
    if (r.state === 'down' && !r.http) {
      await new Promise((res) => setTimeout(res, 2000));
      r = await this.probeOnce(ctx);
    }
    return this.settle(r);
  }

  /** opts.sample：顺带带回接口返回内容的开头（设置里「测试」用，平时不带）。 */
  async probeOnce(ctx, opts = {}) {
    const { probe } = this.env;
    const started = Date.now();
    const r = { state: 'down', checkedAt: started, http: null, commit: null, version: null, resolvedBy: null, error: null, latency: null, detail: null };
    try {
      const res = await fetch(probe.url, {
        headers: { 'user-agent': UA, accept: 'application/json, */*', ...(probe.headers ?? {}) },
        signal: AbortSignal.timeout(probe.timeout),
        redirect: 'follow',
      });
      r.http = res.status;
      r.latency = Date.now() - started;
      const text = await res.text().catch(() => '');
      if (opts.sample) {
        r.contentType = res.headers.get('content-type');
        r.sample = text.slice(0, 1500);
      }
      if (res.status >= 500) {
        r.error = `服务返回 HTTP ${res.status}`;
      } else if (res.status >= 400) {
        // 服务器在线，只是探测地址不对或被拦了：不算宕机，但读不到版本
        r.state = 'up';
        r.detail = res.status === 404 ? '探测地址不存在（HTTP 404）' : `探测地址拒绝访问（HTTP ${res.status}）`;
      } else {
        r.state = 'up';
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          /* 不是 JSON：只能说明在线 */
        }
        if (probe.commit) {
          const v = pick(body, probe.commit);
          if (typeof v === 'string' && /^[0-9a-f]{7,40}$/i.test(v.trim())) {
            r.commit = v.trim().toLowerCase();
            r.resolvedBy = { kind: 'field', field: probe.commit };
          } else r.detail = `接口没有返回 ${probe.commit} 字段`;
        }
        if (probe.version) {
          const v = pick(body, probe.version);
          if (v != null && v !== '') r.version = String(v);
          else if (res.status === 204) r.detail = '当前没有已启用的版本';
          else r.detail = `接口没有返回 ${probe.version} 字段`;
        }
        if (!r.commit && r.version) {
          const found = await resolveVersion(r.version, this.env.resolve, ctx);
          if (found) {
            r.commit = found.commit;
            r.resolvedBy = found.by;
          } else if (this.env.resolve.length) r.detail = `版本 ${r.version} 找不到对应的提交（${this.env.resolve.map(describeRule).join('、')}）`;
          else r.detail = `只知道版本 ${r.version}，没有配置怎么对应到提交`;
        }
        if (!probe.commit && !probe.version) {
          // 没说字段名：在返回的 JSON 里找常见的提交号字段（commit、sha、gitSha、revision……）
          const found = findCommit(body);
          if (found) {
            r.commit = found.value;
            r.resolvedBy = { kind: 'field', field: found.path };
          } else r.detail = '接口没有返回提交号';
        }
      }
    } catch (e) {
      r.latency = Date.now() - started;
      r.error = e.name === 'TimeoutError' ? `超时（${Math.round(probe.timeout / 1000)} 秒）` : explainFetch(e);
    }
    return r;
  }

  settle(r) {
    // 网络偶尔抖一下（DNS、代理）：连续两轮都失败才算连不上，第一次失败沿用上次的结果
    if (r.state === 'down') {
      this.failures++;
      if (this.failures < 2 && (this.result.state === 'up' || this.result.state === 'pending')) {
        this.result = { ...this.result, flaky: r.error };
        return false;
      }
      if (this.result.commit || this.result.lastKnown) {
        r.lastKnown = this.result.lastKnown ?? { commit: this.result.commit, version: this.result.version, at: this.result.checkedAt };
      }
    } else this.failures = 0;
    const prev = this.result;
    this.result = r;
    return prev.state !== r.state || prev.commit !== r.commit || prev.version !== r.version || prev.error !== r.error;
  }
}

const COMMIT_KEY = /^(commit|sha|git_?sha|git_?commit|commit_?sha|source_?commit|source_?git_?sha|revision|build_?commit|hash)$/i;
/** 在 JSON 的前两层里找看起来像提交号的字段。 */
function findCommit(obj, prefix = '', depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 2) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && COMMIT_KEY.test(k) && /^[0-9a-f]{7,40}$/i.test(v.trim())) return { path: prefix + k, value: v.trim().toLowerCase() };
  }
  for (const [k, v] of Object.entries(obj)) {
    const hit = v && typeof v === 'object' ? findCommit(v, prefix + k + '.', depth + 1) : null;
    if (hit) return hit;
  }
  return null;
}

/** 取 JSON 里的字段："a.b.0.c" */
function pick(obj, path) {
  if (obj == null) return undefined;
  let cur = obj;
  for (const k of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function describeRule(rule) {
  if (rule.tag) return `标签 ${rule.tag}`;
  if (rule.manifest) return `清单 ${rule.manifest}`;
  return '未知规则';
}

async function resolveVersion(version, rules, ctx) {
  for (const rule of rules) {
    if (rule.tag) {
      const name = rule.tag.replaceAll('{version}', version);
      const sha = ctx.tags?.get(name);
      if (sha) return { commit: sha, by: { kind: 'tag', tag: name } };
    } else if (rule.manifest) {
      const pattern = rule.manifest.replaceAll('{version}', version);
      for (const root of ctx.checkoutPaths ?? []) {
        const hits = await glob(root, pattern).catch(() => []);
        for (const f of hits) {
          try {
            const json = JSON.parse(await readFile(f, 'utf8'));
            const v = pick(json, rule.field ?? 'commit');
            if (typeof v === 'string' && /^[0-9a-f]{7,40}$/i.test(v)) return { commit: v.toLowerCase(), by: { kind: 'manifest', file: f } };
          } catch {
            /* 读不了的清单跳过 */
          }
        }
      }
    }
  }
  return null;
}

/** 很小的 glob：段内 * ?，跨段 **。只在 root 下面找，最多 6 层，不进 node_modules / .git。 */
async function glob(root, pattern) {
  const segs = pattern.replace(/\\/g, '/').split('/').filter(Boolean);
  const out = [];
  const toRe = (s) => new RegExp('^' + s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  async function walk(dir, i, depth) {
    if (out.length > 50 || depth > 8) return;
    if (i === segs.length) {
      out.push(dir);
      return;
    }
    const seg = segs[i];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (seg === '**') {
      await walk(dir, i + 1, depth);
      for (const e of entries) {
        if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git') await walk(join(dir, e.name), i, depth + 1);
      }
      return;
    }
    const re = toRe(seg);
    for (const e of entries) {
      if (!re.test(e.name)) continue;
      const last = i === segs.length - 1;
      if (last ? e.isFile() : e.isDirectory()) await walk(join(dir, e.name), i + 1, depth + 1);
    }
  }
  await walk(root, 0, 0);
  return out;
}

function explainFetch(e) {
  const c = e.cause?.code ?? e.code;
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return '域名解析失败';
  if (c === 'ECONNREFUSED') return '连接被拒绝（服务没在运行？）';
  if (c === 'ECONNRESET') return '连接被重置';
  if (c === 'CERT_HAS_EXPIRED') return '证书已过期';
  if (String(c).startsWith('ERR_TLS') || String(c).includes('CERT')) return '证书有问题：' + c;
  return e.cause?.message ?? e.message ?? String(e);
}
