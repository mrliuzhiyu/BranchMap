// 云端副本：BranchMap 自己在缓存目录里保存的一份裸仓库（只有 Git 记录，没有代码文件），定时从远程同步。
// 团队的真实进度（main / dev 现状、每个人推上去的分支）都以它为准。
//
// - 第一次建副本时，如果本机已经有这个仓库，先从本机仓库拷一份记录过来（不联网、很快），再联网补齐；
//   本机仓库只被读取，不会被改动。
// - 云端分支存成 refs/remotes/origin/*，标签存成 refs/tags/*。
// - 同步用你电脑上已有的 Git 登录（凭据管理器 / SSH key），没有凭据时直接失败，不会弹窗。
//   连了 GitHub App 时，GitHub 仓库改用 App 的安装令牌（credentials() 给出，放在环境变量里）。
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitNet, firstLine } from '../git.mjs';

const REFSPECS = ['+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*'];
// 副本建好了才写这个文件；没有它的目录是上次没建完的，删掉重来
const READY = 'branchmap-ready';

export class Mirror {
  /** key: 远程地址的规范键；url: 用来同步的地址；credentials(): 联网时额外的环境变量（GitHub App 令牌），可以返回 null */
  constructor({ key, url, dir, credentials = null }) {
    this.key = key;
    this.url = url;
    this.dir = dir;
    this.credentials = credentials ?? (async () => null);
    this.state = {
      status: existsSync(join(dir, READY)) ? 'idle' : 'missing', // missing | cloning | idle | syncing | error
      lastOk: null,
      lastAttempt: null,
      lastChange: null,
      error: null,
      failures: 0,
    };
    this.refsKey = null;
    this.running = null;
  }

  get ready() {
    return existsSync(join(this.dir, READY));
  }

  /** 建副本（如果还没有）。seedDirs：本机同一远程的 git 目录。 */
  async ensure(seedDirs = []) {
    if (this.ready) return;
    this.state.status = 'cloning';
    const tmp = this.dir;
    rmSync(this.dir + '.tmp', { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    await git(tmp, ['init', '--bare', '--quiet']);
    const cfg = [
      ['core.logAllRefUpdates', 'false'],
      ['core.commitGraph', 'true'],
      ['fetch.writeCommitGraph', 'true'],
      ['gc.autoDetach', 'false'],
    ];
    for (const [k, v] of cfg) await git(tmp, ['config', k, v]);
    await git(tmp, ['remote', 'add', 'origin', this.url]);
    await git(tmp, ['config', '--replace-all', 'remote.origin.fetch', REFSPECS[0]]);
    await git(tmp, ['config', '--add', 'remote.origin.fetch', REFSPECS[1]]);
    // 从本机仓库拷记录：它的 origin/* 就是它上次看到的云端，标签也一并带上。只读取，不改动本机仓库。
    for (const seed of seedDirs) {
      try {
        await git(tmp, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', seed, '+refs/remotes/origin/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*']);
        break;
      } catch {
        /* 这份本机仓库读不了就换下一份，最后总会联网 */
      }
    }
    // 本机拷来的记录里可能有云端已经删掉的分支：下面的联网同步会带 --prune 清掉
    writeFileSync(join(tmp, READY), new Date().toISOString());
    this.state.status = 'idle';
  }

  /** 联网同步一次。返回 { changed }。同时只跑一个。 */
  sync() {
    if (this.running) return this.running;
    this.running = this.doSync().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async doSync() {
    const before = await this.readRefsKey();
    this.state.status = 'syncing';
    this.state.lastAttempt = Date.now();
    let attempt = 0;
    const env = await this.credentials().catch(() => null);
    for (;;) {
      try {
        await gitNet(this.dir, ['fetch', 'origin', '--prune', '--quiet', '--no-write-fetch-head'], { env });
        break;
      } catch (e) {
        // 网络偶尔抖一下（代理、TLS 中断）：隔两秒再试一次
        if (++attempt < 2 && !/Authentication|could not read Username|Repository not found|Permission denied|403/i.test(e.stderr ?? '')) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        this.state.status = 'error';
        this.state.error = explain(e);
        this.state.failures++;
        return { changed: false, error: this.state.error };
      }
    }
    // 默认分支（origin/HEAD）第一次需要问一下远程
    if (!(await git(this.dir, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']).catch(() => ''))) {
      await gitNet(this.dir, ['remote', 'set-head', 'origin', '--auto'], { timeout: 60000, env }).catch(() => {});
    }
    this.state.status = 'idle';
    this.state.error = null;
    this.state.failures = 0;
    this.state.lastOk = Date.now();
    const after = await this.readRefsKey();
    const changed = before !== after;
    if (changed) this.state.lastChange = Date.now();
    return { changed };
  }

  /** 所有引用拼成的串：变了就说明云端有新动静。 */
  async readRefsKey() {
    if (!this.ready) return '';
    this.refsKey = await git(this.dir, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/remotes', 'refs/tags']).catch(() => '');
    return this.refsKey;
  }

  /** 下次该什么时候同步：失败了就退避（最多 10 分钟）。 */
  nextDelay(base) {
    if (!this.state.failures) return base;
    return Math.min(600000, 30000 * 2 ** (this.state.failures - 1));
  }
}

function explain(e) {
  const s = `${e?.stderr ?? ''}\n${e?.message ?? ''}`;
  if (/could not read Username|Authentication failed|terminal prompts disabled|Permission denied \(publickey\)/i.test(s)) return '没有权限：GitHub App 没装到这个仓库，或者本机 Git 没有登录这个仓库所在的账号（git 凭据或 SSH key）';
  if (/Repository not found|not found/i.test(s)) return '远程仓库不存在，或者当前账号没有访问权限';
  if (/Could not resolve host|unable to access|TLS|SSL|timed out|超时|Connection (reset|refused)|Failed to connect/i.test(s)) return '连不上远程：' + firstLine(e);
  return firstLine(e);
}
