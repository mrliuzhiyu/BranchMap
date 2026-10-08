// 人：把一个仓里出现过的「名字 + 邮箱」归成人。
// 同一个邮箱、大小写不同的同名、aliases.json 里写在一起的、GitHub 上挂在同一个账号的，都算一个人。
// 头像来自 GitHub 账号：noreply 邮箱直接算出来；其余去 GitHub 问一次（lib/github.mjs 给令牌），结果存在 .cache/accounts.json。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { firstLine } from './git.mjs';

const GENERIC_EMAIL = /^(no-?reply|noreply|root|admin|dev|developer|user|test)@|@(localhost|example\.com|local)$/i;
const NOREPLY = /^(?:(\d+)\+)?([^@+]+)@users\.noreply\.github\.com$/i;
const RETRY_MISS = 7 * 86400 * 1000;

export class Accounts {
  constructor(dir) {
    this.file = join(dir, 'accounts.json');
    this.dir = dir;
    this.map = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
  }
  get(email) {
    const e = email.toLowerCase();
    const m = NOREPLY.exec(e);
    if (m) return { login: m[2], avatar: m[1] ? `https://avatars.githubusercontent.com/u/${m[1]}?s=96&v=4` : `https://avatars.githubusercontent.com/${m[2]}?s=96` };
    const hit = this.map[e];
    if (!hit) return undefined;
    if (!hit.login && Date.now() - hit.at > RETRY_MISS) return undefined;
    return hit.login ? hit : null;
  }
  set(email, user) {
    this.map[email.toLowerCase()] = user ? { login: user.login, avatar: user.avatarUrl, at: Date.now() } : { login: null, at: Date.now() };
  }
  save() {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.map, null, 1));
  }
}

/** 没问过的邮箱，各取一个提交去 GitHub 查它挂在哪个账号上（令牌来自 GitHub App，没连时用本机 gh 的登录）。 */
export async function lookupAccounts(accounts, github, slug, samples) {
  const todo = [...samples].filter(([email]) => email && accounts.get(email) === undefined);
  if (!slug || !todo.length) return;
  const token = await github.tokenFor(slug).catch(() => null);
  if (!token) return; // 读不到这个仓库：头像退回首字，下次再问
  const [owner, name] = slug.split('/');
  for (let i = 0; i < todo.length; i += 80) {
    const chunk = todo.slice(i, i + 80);
    const fields = chunk.map(([, sha], k) => `c${k}: object(oid: "${sha}") { ... on Commit { author { user { login avatarUrl(size: 96) } } } }`);
    const query = `query($owner: String!, $name: String!) { r: repository(owner: $owner, name: $name) { ${fields.join(' ')} } }`;
    let data;
    try {
      // 个别提交没推上去时 GraphQL 带着 errors 返回，但 data 里其余结果照样可用
      data = await github.graphql(token, query, { owner, name });
    } catch (e) {
      console.warn(`  GitHub 账号查询失败（${slug}），头像退回首字：${firstLine(e)}`);
      return;
    }
    const repo = data?.r ?? {};
    chunk.forEach(([email], k) => accounts.set(email, repo[`c${k}`]?.author?.user ?? null));
  }
  accounts.save();
}

/** rows: [name, email] 每个提交一条。返回 { people, idOf(name, email) }。 */
export function groupPeople(pairs, accounts, aliases) {
  const uf = new Map();
  const find = (x) => {
    if (!uf.has(x)) uf.set(x, x);
    let r = x;
    while (uf.get(r) !== r) r = uf.get(r);
    uf.set(x, r);
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) uf.set(rb, ra);
  };
  const nameKey = (n) => 'n:' + n.trim().toLowerCase();
  for (const [display, names] of Object.entries(aliases)) for (const n of names) union(nameKey(display), nameKey(n));

  // pairs: Map "name\0email" -> count
  for (const pk of pairs.keys()) {
    const [n, e] = pk.split('\0');
    find(nameKey(n));
    if (e && !GENERIC_EMAIL.test(e)) union(nameKey(n), 'e:' + e.toLowerCase());
    const acc = e ? accounts.get(e) : null;
    if (acc?.login) union(nameKey(n), 'gh:' + acc.login.toLowerCase());
  }

  const groups = new Map();
  for (const [pk, count] of pairs) {
    const [n] = pk.split('\0');
    const root = find(nameKey(n));
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push([pk, count]);
  }
  const people = [];
  const byPair = new Map();
  for (const members of groups.values()) {
    const names = new Map();
    const emails = new Set();
    let account = null;
    for (const [pk, c] of members) {
      const [n, e] = pk.split('\0');
      names.set(n, (names.get(n) ?? 0) + c);
      if (e) emails.add(e);
      if (!account && e) account = accounts.get(e) ?? null;
    }
    const ranked = [...names].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    const display = Object.keys(aliases).find((d) => ranked.some((n) => find(nameKey(n)) === find(nameKey(d))));
    const id = people.length;
    people.push({
      name: display ?? ranked[0],
      names: ranked,
      emails: [...emails],
      login: account?.login ?? null,
      avatar: account?.avatar ?? null,
      commits: members.reduce((s, [, c]) => s + c, 0),
    });
    for (const [pk] of members) byPair.set(pk, id);
  }
  return { people, byPair };
}
