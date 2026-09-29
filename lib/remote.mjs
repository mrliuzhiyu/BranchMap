// 远程地址：同一个仓库有 https、ssh、带不带 .git、带不带用户名好几种写法，统一成一个键。
//   https://github.com/Owner/Repo.git   → github.com/owner/repo
//   git@github.com:owner/repo.git       → github.com/owner/repo
//   ssh://git@github.com:22/owner/repo  → github.com/owner/repo

export function remoteKey(url) {
  if (!url) return null;
  let s = String(url).trim();
  let host;
  let path;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(s);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  } else if (scp && !/^[A-Za-z]$/.test(scp[1])) {
    host = scp[1];
    path = scp[2];
  } else {
    // 本机路径当远程：用规范化后的路径本身
    return 'file:' + s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!host || !path) return null;
  return `${host.toLowerCase()}/${path.toLowerCase()}`;
}

/** GitHub 仓库的 owner/repo；不是 GitHub 返回 null。 */
export function githubSlug(url) {
  const k = remoteKey(url);
  const m = k && /^github\.com\/([^/]+\/[^/]+)$/.exec(k);
  return m ? m[1] : null;
}

/** 给人看的网页地址（GitHub / GitLab / Gitee 这类都是 https://host/owner/repo）。 */
export function webUrl(url) {
  const k = remoteKey(url);
  if (!k || k.startsWith('file:')) return null;
  return 'https://' + k;
}
