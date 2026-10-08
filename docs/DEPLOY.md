---
status: active
type: guide
verified: 2026-10-07
note: 服务器部署：飞书门禁 + GitHub App 连接；进程守护与 nginx 模板在 deploy/；已部署的机器见第三节
---

# 运行与部署

BranchMap 有两种跑法，代码是同一份，区别只在 `config.json` 里有没有 `auth` 段。

| | 本机 | 服务器（给公司同事看） |
|---|---|---|
| 谁能看 | 只有本机（监听 `127.0.0.1`） | 公司飞书账号登录后可看 |
| `config.json` | 不写 `auth` | 写 `auth`，见下 |
| 改配置（加项目、改环境） | 谁都能改 | 只有 `auth.admins` 里的人能改 |
| 「本机」（未推送 / 未提交、本机分支、工作区） | 显示（扫描 `scan` 里的目录） | 不配 `scan` 就不显示：看板「本机」模块、分支页「本机」筛选与状态列、分支图图例都隐藏 |
| 读私有仓库 | 本机的 Git 凭据；PR / CI / 头像用本机 `gh` 的登录，或连接 GitHub App | 连接 GitHub App（推荐，网页上点「连接 GitHub」）；拉代码也可以用服务器上的 Git 凭据 |

## 一、现状（2026-10-07 按代码与本机配置核对）

- 飞书门禁：`lib/auth.mjs`；连接 GitHub（GitHub App）：`lib/github.mjs`。
- 本机 `config.json` 没有 `auth` 段，即本机不开门禁。
- 进程守护与 nginx 模板：`deploy/branchmap.service`、`deploy/nginx.conf.example`（照 129 上实际在用的整理）。还没有一键部署脚本。
- 部署之后在下面「三、已部署的环境」登记，没登记的不算现状。

## 二、部署到服务器要做的事

1. **反向代理与 HTTPS**：服务写死只监听 `127.0.0.1`，公网访问必须经 nginx 之类的反向代理，
   且要原样转发 Host（`proxy_set_header Host $host;`）——服务只认 `auth.origin` 的域名，Host 不对直接 403。
   页面靠 SSE（`/api/events`）实时刷新，代理上要关掉这条路径的缓冲（`proxy_buffering off;`）。
2. **飞书企业自建应用**：重定向 URL 登记为 `<auth.origin>/auth/callback`。
3. **`config.json` 的 `auth` 段**（不含任何机密）：

   ```jsonc
   "auth": {
     "origin": "https://branchmap.example.com", // 必须 https，飞书只接受 HTTPS 回调
     "feishuAppId": "cli_xxx",
     "tenantKey": "…",                          // 本企业的 tenant_key；先不写，第一次登录时日志会打出来，核对后填上
     "admins": ["张三"]                          // 能改配置的人：飞书 open_id 或飞书名字；不写就谁都不能改
   }
   ```

4. **两个环境变量**（只放在服务器上，不进仓库、不进 `config.json`）：
   `BRANCHMAP_FEISHU_APP_SECRET`（飞书 App Secret）、`BRANCHMAP_SESSION_SECRET`（至少 32 个字符）。
   缺任何一项服务直接拒绝启动，不会带病跑。
5. **连接 GitHub**（推荐）：服务起来后，管理员用飞书登录，在「添加项目」里填上组织名、点「连接 GitHub」：
   - GitHub 打开「创建应用」页，权限（全部只读）、回调、Webhook 都已填好，点创建；
   - 接着在安装页选组织、勾选要看的仓库；回到 BranchMap，「添加项目」里就列出这些仓库，勾选添加。
   - App 的凭据由服务端自动换得，存在缓存目录的 `github-app.json`（600），不用手动复制。以后增减仓库点「管理授权」。
   - 私有 App 只能装到建它的账号上，所以要建在组织名下：需要组织 owner（或被授予 App 管理权限的人）来点。
   - 机器访问不了 `github.com` 的 HTTPS 时，拉代码可以给服务用户配 SSH key 并设 `url."git@github.com:".insteadOf "https://github.com/"`，
     PR / CI / 头像照样走 App（只访问 `api.github.com`）。
6. **Git 凭据**（不连 App 时）：服务器上给 Git 配好能读这些仓库的只读凭据，PR / CI 另需 `gh auth login`。没有凭据时同步报错，不会弹窗。
7. **起服务**：`npm ci --omit=dev`，用 `deploy/branchmap.service` 常驻；nginx 用 `deploy/nginx.conf.example`（含 Webhook 的 10 MB 请求体上限）。

规矩（照 Siltok 的部署约定）：

- 部署是手动的，从一个确定的提交发布；合并不触发部署。部署之前要有用户授权。
- 机密只在服务器的环境变量里，不写进本仓任何文件。
- 部署资产（以后要写的脚本、nginx 模板、进程守护配置）放在本仓 `deploy/`，跟代码同一个提交，不另建运维仓。

## 三、已部署的环境

| 机器 | 地址 | 运行的提交 | 部署日期 | 登记人 |
|---|---|---|---|---|
| 阿里云 ECS（华北2，个人账号，2 核 3.4G，和 `imoky` 的测试站共用，各自独立的 nginx 站点文件） | `https://<部署域名>` → `<服务器 IP>`（服务只听 `127.0.0.1:4317`） | `db49310` | 2026-10-07 | Claude（用户授权） |

改了服务器（换机器、换域名、换提交）就同步改这张表，并更新文件头的 `verified`。

129 上的布置：`branchmap` 系统用户；程序 `/opt/branchmap/app`（git clone，`git pull` 更新）、私有 Node 22 与 gh 在 `/opt/branchmap`；
数据 `/var/lib/branchmap`（`cache/` 下是云端副本，连上 GitHub App 后有 `github-app.json`）；机密 `/etc/branchmap/env`（root:branchmap 640）；
systemd `branchmap.service` 与 nginx `/etc/nginx/conf.d/branchmap.conf` 就是 `deploy/` 里的两份（域名换成 `<部署域名>`）；证书 Let's Encrypt，certbot 自动续期。
那台机器 HTTPS 访问 `github.com` 基本不通，`branchmap` 用户设了 `url."git@github.com:".insteadOf`，拉代码走 SSH（账号级 key `branchmap@<部署域名>`）；
`api.github.com` 访问稳定，PR / CI / 头像走 GitHub App。同一域名放在公司账号的机器（乌兰察布）上会被备案拦截，2026-10-07 试过，已撤回并清理。
