# 连接 GitHub：用 GitHub App 授权读仓库（产品化第一步，单租户）

> 日期：2026-10-07
> 状态：🔧 实现中（代码与本机验证完成；待在服务器上创建 App、安装到组织后验收）
> 工程基底：`main` = `bc77356`，工作区里本次改动之外没有别的未提交改动

---

## 一、问题

**现象**：服务器上部署 BranchMap 时，读 PR / CI / 头像要在服务器上 `gh auth login`，
而那台机器连 `github.com` 时通时不通，设备码登录走不通；拉代码靠一把加在个人账号上的 SSH key（账号级、可写）。
每换一台机器、每加一个仓库都要人上服务器配凭据。用户要的是「登录授权 GitHub 仓库，方便」，并且想把 BranchMap 产品化。

**原则**：只读（App 申请的权限全部只读）；密钥不进仓库；通用工具（不写死 Siltok）；网站登录仍用飞书门禁（用户 2026-10-07 定）；
先做单租户、不做多租户（用户定）。

**方案**：GitHub App，并用 App Manifest 流程把「创建应用」做成网页上点一下：

1. 管理员在「添加项目」里点「连接 GitHub」（可填组织名）→ 自动提交 manifest 到 GitHub 的创建页，权限、回调、Webhook 都预填；
2. GitHub 带 code 回到 `/github/created`，服务端用 `POST /app-manifests/{code}/conversions` 换出 App ID、私钥、Webhook 密钥，
   存进缓存目录 `github-app.json`（600，git 忽略）；
3. 跳到安装页选组织、勾仓库，回到 `/github/installed` → 打开「添加项目」，列出已授权的仓库，可多选；
4. PR、审核、CI、头像改走 `api.github.com`（安装令牌，1 小时过期、只限勾选的仓库），去掉对 `gh` 命令行的依赖；
   拉代码时安装令牌放进 `GIT_CONFIG_*` 环境变量（不进命令行参数）；推送、PR、检查有变动时 GitHub 发 Webhook，立即同步 / 刷新。

不选 OAuth App：`repo` 范围等于所有私有仓库读写，企业不会同意。不选个人 Token：只适合自用。
不做「用 GitHub 登录网站」：用户定了网站登录仍用飞书；而且那条路要服务器访问 `github.com/login/oauth/access_token`，那台服务器上不稳。
本机（不连 App）退回本机 `gh auth token` 的登录，行为与以前一致。

**改动范围**：
- 新增 `lib/github.mjs`：Manifest 表单、换凭据、App JWT（RS256）、安装令牌缓存、已授权仓库列表、Webhook 签名校验、本机 gh 令牌兜底
- `lib/repo.mjs`：PR 列表改 REST、打开的 PR 的审核与检查改 GraphQL，输出结构不变
- `lib/people.mjs`：头像查询改用 GraphQL 接口
- `lib/git.mjs`、`lib/sources/cloud.mjs`：联网 git 可带额外环境变量（App 令牌）
- `lib/project.mjs`：Workspace 持有 `GitHub`，接到副本同步与 PR 读取
- `server.mjs`：`/github/connect|created|installed`（管理员）、`POST /api/github/webhook`（签名认人，不走飞书门禁）、`GET /api/github`
- `web/lib/addproject.js`、`web/app.js`、`web/lib/util.js`、`web/style.css`：连接入口、授权仓库多选、装完回来自动打开

---

## 二、验收标准

### AC-1: 本机（不连 App）PR 数据与原来 `gh pr list` 逐条一致
- [x] **检查命令**：本机 `node server.mjs --port=4399`，取 `/api/p/{web,dash}/prs?refresh=1`，与 `gh pr list --state all --limit 500` 和打开 PR 的 `reviewDecision / statusCheckRollup` 逐条比对状态、分支、合并提交、审核、检查数
- **通过标准**：差异 0
- **证伪路径**：有差异 → 字段映射写错（REST 的 `merge_commit_sha` 在未合并 PR 上也有值、`draft` 与 `state` 的组合），对照修

### AC-2: GitHub 模块单元行为
- [x] Manifest 只读权限、回调 / 安装 / Webhook 地址正确；组织与个人两种创建地址；state 一次性、过期拒绝
- [x] 换凭据后文件 600、重新加载认得；App JWT 能用公钥验、`iss` = App ID、有效期 ≤ 10 分钟
- [x] 安装令牌与仓库列表走缓存；没授权的仓库强制刷新一次后仍返回 null，并给出「没装到这个仓库」
- [x] Webhook 签名对 / 错 / 缺失；`/api/github` 状态里不含任何密钥
- **检查命令**：草稿目录的 `github-test.mjs`（假的 GitHub 接口）
- **证伪路径**：任何一条失败 → 不上服务器

### AC-3: 路由
- [x] 未连接时连接页提交到创建页、本机不开 Webhook；坏组织名 400；伪造 state 400；未连接时 Webhook 一律 401
- [x] 已连接时点连接直接去安装页；推送 Webhook 202 并触发一次同步；安装变动 202；PR 读不到时原因写清楚
- [x] 开飞书门禁时：Webhook 不走门禁（签名对就收、错就 401），连接页与 `/api/github` 仍要求登录
- **检查命令**：草稿目录的 `routes-test.sh`（隔离副本、独立缓存目录、公开仓库 `octocat/Hello-World`）

### AC-4: 界面
- [x] 「添加项目」未连接时显示连接入口（可填组织名）；已连接时列出授权仓库、已加的灰掉、可多选（按钮变「添加 N 个」）、多于 8 个出搜索且输入不丢焦点
- **检查命令**：无头 Edge 截图（已连接状态用假数据）
- [x] 深色模式、420px 窄屏下再看一次（弹窗完整显示；底下看板在这么窄时本来就横向溢出，与本次无关）

### AC-5: 服务器上真实走通（待用户在 GitHub 上操作）
- [ ] 服务器上点「连接 GitHub」→ 在 `siltok-ai` 组织下创建 App → 安装并勾选仓库 → 回到「添加项目」能看到这些仓库
- [ ] 服务器上不再需要 `gh auth login`：PR、CI、头像正常显示
- [ ] 在任一仓库推一个提交，几秒内页面刷新（Webhook）
- **证伪路径**：组织不允许成员创建 App → 请组织 owner 操作，或在个人账号下建公开 App 再安装到组织

### 全局
- [x] `node --check` 全部改动文件
- [x] 相关文档按工程证据更新（README、AGENTS.md「密钥」、docs/DEPLOY.md、新增 `deploy/`），`npm run check:docs` 通过

---

## 三、实现记录

- **凭据存缓存目录而不是 `config.json`**：`config.json` 页面上会改写（加项目、改环境），机密混进去容易被复制、贴出来；
  缓存目录本来就被 git 忽略，单独一个 600 文件，删掉就等于断开。AGENTS.md「密钥」一节同步改了说法（以前写的是「BranchMap 不保存凭据」）。
- **私有 App 只能装到建它的账号**：所以连接入口让填组织名，默认建在组织下；个人账号下建的私有 App 装不到组织上。
- **本机兜底用 `gh auth token`，缓存 6 小时、并发只跑一次**：实测这台电脑上 gh 从系统钥匙串取令牌要 30～45 秒（原来 `gh pr list` 给了 45 秒超时所以没暴露），
  10 秒超时会让本机的 PR 全部读不到。令牌 401 时作废重取。
- **Webhook 推送时如果正好在同步**：那一次 fetch 可能早于这次推送，等它结束再同步一次，免得漏。
- **PR 类事件 3 秒合并一次**：一次推送会带出一串 `check_run`，每个都刷新会把 PR 接口打满。
- **那台服务器上拉代码仍走 SSH**：那台机器 HTTPS 访问 `github.com` 基本不通（8 次成功 1 次），`branchmap` 用户的 `url.insteadOf` 把地址改写成 SSH，
  App 令牌头只对 HTTPS 生效，所以那里拉代码还是用账号 SSH key；PR / CI / 头像走 `api.github.com`（那台机器访问稳定）就不再需要 gh。
  换到能稳定访问 GitHub 的机器（比如香港）后，去掉 `insteadOf` 和那把 SSH key，拉代码就全走 App 令牌。

- **提交 `db49310` 顺带带进了别的会话的 3 行头像样式**（`web/style.css`：`.av` 的 `aspect-ratio`、`.av.s14`、`.mcnt .av`）：
  那是上一次治理提交时就记着「别的会话未提交」的改动，这次暂存时没逐行核对就整个文件加了进去，违反了「不动别的会话的改动」。
  内容与服务器上被人直接热修的那份一致、是有效的修复；已推送，按约定不改写历史，在这里留痕。以后暂存前用 `git diff <文件>` 逐个核对。
- **部署 `db49310` 到服务器时 `git pull` 被拒**：服务器上的 `web/style.css` 被人直接改过（就是上面那 3 行，外加换成 CRLF）。核对与 `main` 一致后丢弃本地改动再拉。
  以后不在服务器上直接改代码，改动走仓库提交。

---

## 四、验收结果

| AC | 结果 | 日期 |
|----|------|------|
| AC-1 | ✅ 官网 1 条、Dash 294 条逐条一致；Dash 打开的 4 个 PR 审核与检查数一致 | 2026-10-07 |
| AC-2 | ✅ | 2026-10-07 |
| AC-3 | ✅ 20 项（其中一项是测试脚本把相对跳转补成了 127.0.0.1，行为本身正确） | 2026-10-07 |
| AC-4 | ✅ 浅色宽屏、深色窄屏 | 2026-10-07 |
| AC-5 | ⏳ 待用户在 GitHub 上操作 | |
| 全局 | ✅ | 2026-10-07 |

---

## 五、归档时摘出的非代码活

- [ ] 服务器：在「添加项目」里连接 GitHub（建在 `siltok-ai` 组织下）、安装并勾选仓库
- [x] 域名解析改回部署用的那台服务器（2026-10-07 已改回）
- [ ] 换到能稳定访问 GitHub 的机器后：去掉 `branchmap` 用户的 `url.insteadOf`，从 GitHub 账号删掉服务用户的那把 SSH key
