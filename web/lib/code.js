// 代码显示：语法高亮（highlight.js）、解析 git 补丁、统一 / 并排两种差异视图、行内改动标记、整篇文件视图。
import hljs from '/vendor/highlight.js';
import { esc, icon, lineStat, IMAGE_EXT } from './util.js';

/* ---------- 语言 ---------- */
const EXT = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  py: 'python', pyi: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', m: 'objectivec', mm: 'objectivec', rb: 'ruby', php: 'php', lua: 'lua', pl: 'perl', r: 'r', sql: 'sql', graphql: 'graphql', gql: 'graphql',
  css: 'css', scss: 'scss', less: 'less', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml', plist: 'xml', xaml: 'xml', csproj: 'xml',
  json: 'json', jsonc: 'json', json5: 'json', webmanifest: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', env: 'bash',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown', sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  bat: 'dos', cmd: 'dos', diff: 'diff', patch: 'diff', proto: 'protobuf', dart: 'dart', scala: 'scala', hs: 'haskell', ex: 'elixir', exs: 'elixir', erl: 'erlang',
  tf: 'ini', nginx: 'nginx', dockerfile: 'dockerfile', makefile: 'makefile', mk: 'makefile', cmake: 'cmake', gradle: 'gradle', groovy: 'groovy',
};
const NAMES = { dockerfile: 'dockerfile', makefile: 'makefile', 'cmakelists.txt': 'cmake', '.gitignore': 'bash', '.env': 'bash', 'nginx.conf': 'nginx', jenkinsfile: 'groovy' };
export function langOf(path) {
  const base = path.split('/').pop().toLowerCase();
  if (NAMES[base]) return NAMES[base];
  if (base.startsWith('dockerfile')) return 'dockerfile';
  const ext = base.includes('.') ? base.split('.').pop() : '';
  return EXT[ext] ?? null;
}
const loading = new Map();
/** 默认包里没有的语言按需从 /vendor/lang/ 加载。 */
export async function ensureLang(lang) {
  if (!lang || hljs.getLanguage(lang)) return !!lang;
  if (!loading.has(lang)) {
    loading.set(lang, import(`/vendor/lang/${lang}.js`).then((m) => {
      hljs.registerLanguage(lang, m.default);
      return true;
    }).catch(() => false));
  }
  return loading.get(lang);
}

/** 把高亮后的 HTML 按行拆开，跨行的 span 在行尾关上、下一行开头重新打开。 */
export function splitHtmlLines(html) {
  const out = [];
  const stack = [];
  let cur = '';
  const re = /(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) { stack.push(m[1]); cur += m[1]; }
    else if (m[2]) { stack.pop(); cur += m[2]; }
    else if (m[3]) { out.push(cur + '</span>'.repeat(stack.length)); cur = stack.join(''); }
    else cur += m[4];
  }
  out.push(cur);
  return out;
}
const MAX_HL = 600 * 1024;
export function highlightLines(text, lang) {
  if (lang && hljs.getLanguage(lang) && text.length <= MAX_HL) {
    try {
      return splitHtmlLines(hljs.highlight(text, { language: lang, ignoreIllegals: true }).value);
    } catch { /* 高亮失败就退回纯文本 */ }
  }
  return text.split('\n').map(esc);
}

/** 在高亮后的一行 HTML 里，给第 start..end 个字符套上 <mark>（遇到标签先关后开，保证嵌套合法）。 */
function markHtml(html, start, end, cls) {
  if (start >= end) return html;
  let out = '';
  let pos = 0;
  let open = false;
  const openTag = `<mark class="${cls}">`;
  const re = /(<[^>]+>)|(&[#\w]+;)|([^<&]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) {
      out += open ? '</mark>' + m[1] + openTag : m[1];
      continue;
    }
    const piece = m[2] ? [m[2]] : null;
    const text = m[3] ?? '';
    const step = (chunk, len) => {
      if (!open && pos >= start && pos < end) { out += openTag; open = true; }
      out += chunk;
      pos += len;
      if (open && pos >= end) { out += '</mark>'; open = false; }
    };
    if (piece) { step(piece[0], 1); continue; }
    for (let i = 0; i < text.length; ) {
      let n = text.length - i;
      if (pos < start) n = Math.min(n, start - pos);
      else if (pos < end) n = Math.min(n, end - pos);
      step(text.slice(i, i + n), n);
      i += n;
    }
  }
  if (open) out += '</mark>';
  return out;
}
function changedRange(a, b) {
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a[p] === b[p]) p++;
  let s = 0;
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return [p, a.length - s, b.length - s];
}

/* ---------- 补丁 ---------- */
export function parsePatch(patch) {
  const hunks = [];
  let cur = null;
  let o = 0;
  let n = 0;
  for (let l of patch.split('\n')) {
    if (l.endsWith('\r')) l = l.slice(0, -1);
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(l);
      if (!m) continue;
      cur = { header: l, ctx: m[5] ?? '', lines: [] };
      o = Number(m[1]);
      n = Number(m[3]);
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    const c = l[0];
    if (c === '+') cur.lines.push({ t: '+', x: l.slice(1), n: n++ });
    else if (c === '-') cur.lines.push({ t: '-', x: l.slice(1), o: o++ });
    else if (c === ' ') cur.lines.push({ t: ' ', x: l.slice(1), o: o++, n: n++ });
    else if (c === '\\') cur.lines.push({ t: '\\', x: l.slice(2) });
  }
  return hunks;
}

/** 给每行算好高亮 HTML（旧、新两侧分别整段高亮，保证多行注释/字符串正确），再标出行内改动。 */
function prepare(hunks, lang) {
  const total = hunks.reduce((s, h) => s + h.lines.length, 0);
  const useLang = total <= 30000 ? lang : null;
  for (const h of hunks) {
    const oldL = h.lines.filter((l) => l.t === ' ' || l.t === '-');
    const newL = h.lines.filter((l) => l.t === ' ' || l.t === '+');
    const oh = highlightLines(oldL.map((l) => l.x).join('\n'), useLang);
    const nh = highlightLines(newL.map((l) => l.x).join('\n'), useLang);
    oldL.forEach((l, i) => (l.html = oh[i] ?? ''));
    newL.forEach((l, i) => (l.html = nh[i] ?? ''));
    // 成块的「删几行、加几行」一一配对，标出改了的那一段
    const L = h.lines;
    for (let i = 0; i < L.length; ) {
      if (L[i].t !== '-') { i++; continue; }
      let j = i;
      while (j < L.length && L[j].t === '-') j++;
      let k = j;
      while (k < L.length && L[k].t === '+') k++;
      const dels = L.slice(i, j);
      const adds = L.slice(j, k);
      const pairs = Math.min(dels.length, adds.length);
      if (dels.length <= 40 && adds.length <= 40) {
        for (let p = 0; p < pairs; p++) {
          const a = dels[p].x;
          const b = adds[p].x;
          const [s, ea, eb] = changedRange(a, b);
          const longest = Math.max(a.length, b.length);
          const changed = Math.max(ea - s, eb - s);
          if (longest && changed > 0 && changed / longest < 0.7 && a.trim() && b.trim()) {
            dels[p].html = markHtml(dels[p].html, s, ea, 'id');
            adds[p].html = markHtml(adds[p].html, s, eb, 'ia');
          }
        }
      }
      i = k;
    }
  }
}

const LIMIT = 4000;
function unifiedHtml(hunks, limit) {
  const out = [];
  let count = 0;
  for (const h of hunks) {
    out.push(`<div class="ln hunk"><span class="no">…</span><span class="no">…</span><span class="sg"></span><span class="tx">${esc(h.header)}</span></div>`);
    for (const l of h.lines) {
      if (++count > limit) return { html: out.join(''), cut: true };
      if (l.t === '\\') { out.push(`<div class="ln"><span class="no"></span><span class="no"></span><span class="sg"></span><span class="tx eof">${esc(l.x)}</span></div>`); continue; }
      const cls = l.t === '+' ? 'add' : l.t === '-' ? 'del' : '';
      out.push(`<div class="ln ${cls}"><span class="no">${l.o ?? ''}</span><span class="no">${l.n ?? ''}</span><span class="sg">${l.t === ' ' ? '' : l.t === '-' ? '−' : '+'}</span><span class="tx">${l.html || ' '}</span></div>`);
    }
  }
  return { html: out.join(''), cut: false };
}
function splitHtml(hunks, limit) {
  const out = [];
  let count = 0;
  const cell = (l, side) => (l ? `<span class="no ${side}">${side === 'del' ? l.o : l.n}</span><span class="tx ${side}">${l.html || ' '}</span>` : '<span class="no nil"></span><span class="tx nil"></span>');
  for (const h of hunks) {
    out.push(`<div class="ln hunk"><span class="no">…</span><span class="tx">${esc(h.header)}</span><span class="no">…</span><span class="tx"></span></div>`);
    const L = h.lines.filter((l) => l.t !== '\\');
    for (let i = 0; i < L.length; ) {
      if (++count > limit) return { html: out.join(''), cut: true };
      if (L[i].t === ' ') {
        const l = L[i++];
        out.push(`<div class="ln"><span class="no">${l.o}</span><span class="tx">${l.html || ' '}</span><span class="no">${l.n}</span><span class="tx">${l.html || ' '}</span></div>`);
        continue;
      }
      const dels = [];
      const adds = [];
      while (i < L.length && L[i].t === '-') dels.push(L[i++]);
      while (i < L.length && L[i].t === '+') adds.push(L[i++]);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push(`<div class="ln">${cell(dels[k], 'del')}${cell(adds[k], 'add')}</div>`);
    }
  }
  return { html: out.join(''), cut: false };
}

/* ---------- 差异视图 ----------
   file: { p, old, st, add, del, bin }；load({ ctx, ws }) → { patch, binary, tooLarge }；images: { before, after } 图片地址 */
const prefs = (() => {
  try { return JSON.parse(localStorage.getItem('bm-diff') || '{}'); } catch { return {}; }
})();
const savePrefs = () => { try { localStorage.setItem('bm-diff', JSON.stringify(prefs)); } catch { /* 无痕模式 */ } };

export function mountDiff(el, { file, load, images = null, nav = null, extraActions = '' }) {
  let mode = prefs.mode ?? 'unified';
  let ws = !!prefs.ws;
  let full = false;
  let limit = LIMIT;
  let data = null;
  let token = 0;
  const lang = langOf(file.p);
  const isImage = IMAGE_EXT.test(file.p);

  el.innerHTML = `<div class="diff">
    <div class="diff-h">
      <span class="st ${esc(file.st)}">${esc(file.st)}</span>
      <span class="path ell" title="${esc(file.p)}">${file.old && file.old !== file.p ? `<span class="muted">${esc(file.old)} → </span>` : ''}${esc(file.p)}</span>
      ${lineStat(file.add, file.del)}
      <span class="grow"></span>
      ${extraActions}
      <div class="seg" data-g="mode"><button data-mode="unified">统一</button><button data-mode="split">并排</button></div>
      <label class="check" title="忽略空白"><input type="checkbox" data-ws ${ws ? 'checked' : ''}>忽略空白</label>
      <label class="check" title="整个文件"><input type="checkbox" data-full>全文</label>
      ${nav ? `<button class="icon-btn" data-prev title="上一个文件 (K)">${icon.chevronDown(14).replace('<svg', '<svg style="transform:rotate(180deg)"')}</button><button class="icon-btn" data-next title="下一个文件 (J)">${icon.chevronDown(14)}</button>` : ''}
    </div>
    <div class="diff-b"><div class="loading">加载中…</div></div>
  </div>`;
  const body = el.querySelector('.diff-b');
  const segBtns = el.querySelectorAll('[data-mode]');
  const syncSeg = () => segBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  syncSeg();

  const draw = () => {
    if (!data) return;
    if (data.error) { body.innerHTML = `<div class="empty">${esc(data.error)}</div>`; return; }
    if (isImage && images && (images.before || images.after)) {
      body.innerHTML = images.before && images.after
        ? `<div class="img-diff"><figure><img src="${esc(images.before)}" alt=""><figcaption class="muted">之前</figcaption></figure><figure><img src="${esc(images.after)}" alt=""><figcaption class="muted">之后</figcaption></figure></div>`
        : `<div class="img-one"><figure style="margin:0;display:grid;gap:8px;justify-items:center"><img src="${esc(images.after || images.before)}" alt=""><figcaption class="muted">${images.after ? '新增' : '已删除'}</figcaption></figure></div>`;
      return;
    }
    if (data.tooLarge) { body.innerHTML = `<div class="empty">差异过大（${Math.round(data.size / 1024)} KB）</div>`; return; }
    if (data.binary) { body.innerHTML = '<div class="empty">二进制文件</div>'; return; }
    if (data.dir) { body.innerHTML = '<div class="empty">目录</div>'; return; }
    if (!data.hunks.length) { body.innerHTML = `<div class="empty">${ws ? '仅空白改动' : file.st === 'R' ? '仅重命名' : '无文本差异'}</div>`; return; }
    const { html, cut } = (mode === 'split' ? splitHtml : unifiedHtml)(data.hunks, limit);
    const total = data.hunks.reduce((s, h) => s + h.lines.length, 0);
    body.innerHTML = `<div class="code diff-${mode === 'split' ? 's' : 'u'}">${html}</div>${cut ? `<div class="empty"><button class="btn" data-more>显示全部 ${total} 行</button></div>` : ''}`;
  };
  const fetchIt = async () => {
    const my = ++token;
    body.style.opacity = data ? '0.5' : '';
    try {
      const [res] = await Promise.all([load({ ctx: full ? 100000 : 3, ws }), ensureLang(lang)]);
      if (my !== token) return;
      data = res;
      if (res.patch !== undefined && !res.binary && !res.tooLarge) {
        data.hunks = parsePatch(res.patch);
        prepare(data.hunks, lang);
      }
    } catch (e) {
      if (my !== token) return;
      data = { error: e.message };
    }
    body.style.opacity = '';
    draw();
  };
  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-mode],[data-more],[data-prev],[data-next]');
    if (!t) return;
    if (t.dataset.mode) { mode = prefs.mode = t.dataset.mode; savePrefs(); syncSeg(); draw(); }
    else if (t.dataset.more !== undefined) { limit = Infinity; draw(); }
    else if (t.dataset.prev !== undefined) nav?.prev();
    else if (t.dataset.next !== undefined) nav?.next();
  });
  el.addEventListener('change', (e) => {
    if (e.target.matches('[data-ws]')) { ws = prefs.ws = e.target.checked; savePrefs(); fetchIt(); }
    if (e.target.matches('[data-full]')) { full = e.target.checked; fetchIt(); }
  });
  fetchIt();
}

/* ---------- 整篇文件 ---------- */
export async function renderFileHtml(text, path) {
  const lang = langOf(path);
  await ensureLang(lang);
  const lines = highlightLines(text.replace(/\r\n/g, '\n').replace(/\n$/, ''), lang);
  return `<div class="code file-view">${lines.map((l, i) => `<div class="ln" id="L${i + 1}"><span class="no">${i + 1}</span><span class="tx">${l || ' '}</span></div>`).join('')}</div>`;
}
export { hljs };
