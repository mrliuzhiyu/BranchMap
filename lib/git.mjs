// 运行 git：只读命令，统一编码与参数；同时跑的进程数有上限，免得一次开几百个。
import { execFile } from 'node:child_process';

const MAX_PARALLEL = 8;
let running = 0;
const waiting = [];

function acquire() {
  if (running < MAX_PARALLEL) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LANG: 'C.UTF-8' };
const BASE = ['--no-optional-locks', '-c', 'core.quotepath=off', '-c', 'i18n.logOutputEncoding=utf-8', '-c', 'color.ui=false', '-c', 'log.showSignature=false'];

/** 在 cwd 里跑 git，返回 stdout（字符串，或 buffer: true 时的 Buffer）。失败时 error.stderr 里是 git 的原话。 */
export async function git(cwd, args, { buffer = false, maxBuffer = 512 * 1024 * 1024 } = {}) {
  await acquire();
  try {
    return await new Promise((resolve, reject) => {
      execFile('git', [...BASE, ...args], { cwd, env, maxBuffer, windowsHide: true, encoding: buffer ? 'buffer' : 'utf8' }, (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = String(stderr ?? '');
          reject(err);
        } else resolve(stdout);
      });
    });
  } finally {
    release();
  }
}

/** 跑别的命令（gh）。 */
export function run(cmd, args, { cwd, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, env, maxBuffer: 256 * 1024 * 1024, windowsHide: true, timeout }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = String(stderr ?? '');
        reject(err);
      } else resolve(stdout);
    });
  });
}

export const firstLine = (e) => String(e?.stderr || e?.message || e).trim().split('\n')[0];

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
