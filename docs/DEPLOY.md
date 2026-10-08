---
status: active
type: guide
verified: 2026-10-07
note: 服务器部署的代码已就绪（飞书门禁），仓库里还没有部署脚本，也没有登记过任何一台服务器
---

# 运行与部署

BranchMap 有两种跑法，代码是同一份，区别只在 `config.json` 里有没有 `auth` 段。

| | 本机 | 服务器（给公司同事看） |
|---|---|---|
| 谁能看 | 只有本机（监听 `127.0.0.1`） | 公司飞书账号登录后可看 |
| `config.json` | 不写 `auth` | 写 `auth`，见下 |
| 改配置（加项目、改环境） | 谁都能改 | 只有 `auth.admins` 里的人能改 |
| 读私有仓库 | 本机的 Git 凭据 | 服务器上的 Git 凭据（只读的 deploy key 或令牌） |

## 一、现状（2026-10-07 按代码与本机配置核对）

- 飞书门禁代码已在 `main`（`3c79d2f`，`lib/auth.mjs`）。
- 本机 `config.json` 没有 `auth` 段，即本机不开门禁。
- 仓库里**没有**部署脚本、进程守护（systemd / pm2）配置、nginx 模板。
- **没有登记过任何一台跑着 BranchMap 的服务器**。部署之后在下面「三、已部署的环境」登记，没登记的不算现状。

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
5. **Git 凭据**：服务器上给 Git 配好能读这些仓库的只读凭据。没有凭据时同步报错，不会弹窗。
6. **起服务**：`npm ci && npm run serve`，用进程守护保持常驻。

规矩（照 Siltok 的部署约定）：

- 部署是手动的，从一个确定的提交发布；合并不触发部署。部署之前要有用户授权。
- 机密只在服务器的环境变量里，不写进本仓任何文件。
- 部署资产（以后要写的脚本、nginx 模板、进程守护配置）放在本仓 `deploy/`，跟代码同一个提交，不另建运维仓。

## 三、已部署的环境

| 机器 | 地址 | 运行的提交 | 部署日期 | 登记人 |
|---|---|---|---|---|
| （暂无） | | | | |

改了服务器（换机器、换域名、换提交）就同步改这张表，并更新文件头的 `verified`。
