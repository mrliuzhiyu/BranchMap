// 运行 git：只读命令，统一编码与参数；同时跑的进程数有上限，免得一次开几百个。
// 联网的命令（只有 BranchMap 自己的云端副本会 fetch）另走一个小队列，带超时，永远不弹登录窗口。
import { execFile } from 'node:child_process';

function pool(max) {
  let running = 0;
  const waiting = [];
  return {
    acquire() {
      if (running < max) {
        running++;
        return Promise.resolve();
      }
      return new Promise((resolve) => waiting.push(resolve));
    },
    release() {
      const next = waiting.shift();
      if (next) next();
      else running--;
    },
  };
}
const local = pool(8);
const net = pool(3);

const env = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  // Git Credential Manager：没有现成凭据时直接失败，不弹浏览器或窗口
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
  LANG: 'C.UTF-8',
};
const BASE = ['--no-optional-locks', '-c', 'core.quotepath=off', '-c', 'i18n.logOutputEncoding=utf-8', '-c', 'color.ui=false', '-c', 'log.showSignature=false'];

function exec(cmd, args, { cwd, buffer = false, maxBuffer = 512 * 1024 * 1024, timeout = 0, input = null }) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { cwd, env, maxBuffer, windowsHide: true, timeout, encoding: buffer ? 'buffer' : 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = String(stderr ?? '');
        if (err.killed && timeout) err.stderr = `超时（${Math.round(timeout / 1000)} 秒）` + (err.stderr ? '：' + err.stderr : '');
        reject(err);
      } else resolve(stdout);
    });
    if (input != null) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

/** 在 cwd 里跑 git，返回 stdout（字符串，或 buffer: true 时的 Buffer）。失败时 error.stderr 里是 git 的原话。 */
export async function git(cwd, args, opts = {}) {
  await local.acquire();
  try {
    return await exec('git', [...BASE, ...args], { cwd, ...opts });
  } finally {
    local.release();
  }
}

/** 联网的 git（clone / fetch / ls-remote），默认 3 分钟超时。 */
export async function gitNet(cwd, args, { timeout = 180000 } = {}) {
  await net.acquire();
  try {
    return await exec('git', [...BASE, ...args], { cwd, timeout });
  } finally {
    net.release();
  }
}

/** 跑别的命令（gh）。 */
export function run(cmd, args, { cwd, timeout = 20000 } = {}) {
  return exec(cmd, args, { cwd, timeout, maxBuffer: 256 * 1024 * 1024 });
}

export const firstLine = (e) => {
  const lines = String(e?.stderr || e?.message || e).trim().split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[0] ?? '未知错误';
};

/** 客户端传来的 ref / 提交号：不能以 - 开头（防止被当成选项），不能带控制字符。 */
export function checkRev(rev) {
  if (typeof rev !== 'string' || !rev || rev.length > 400 || rev.startsWith('-') || /[\x00-\x1f\x7f\s~^:?*[\\]/.test(rev) || rev.includes('..')) {
    throw Object.assign(new Error('非法的引用：' + rev), { status: 400 });
  }
  return rev;
}
export function checkPath(p) {
  if (typeof p !== 'string' || !p || p.length > 4096 || /[\x00]/.test(p) || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..')) {
    throw Object.assign(new Error('非法的路径：' + p), { status: 400 });
  }
  return p;
}

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
