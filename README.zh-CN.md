# BranchMap

[English](README.md) · 中文

看清每个项目的代码走到了哪一站：谁在做什么，合进 dev 没有，部署到测试 / 生产没有，线上跑的是哪个提交，哪里不健康。

它不是 Git 客户端：不提交、不切分支、不改你的仓库。一个仓库一个项目，一个项目一页。
可以在自己电脑上跑（只给自己看），也可以部署到服务器给团队看（飞书登录、连接 GitHub App）。

## 看什么

- **看板**（首页）：每个项目一张卡。
  - 线路图：进行中的分支汇入 dev，dev 到 main 之间标出「待上线」「没回合」的提交数，测试 / 生产等环境挂在各自的分支上。
  - 需要处理的问题（健康检查），点进去就是要处理的地方。
  - 右侧：跨项目的成员动态；在本机跑时还有「本机」——哪些分支未推送、哪些工作区有未提交的改动。
- **分支图**：一个项目的提交图。
  - 默认是完整的 git 提交图；「主线」视图只看 main、dev 两条线和还没合进去的分支。main 永远在 dev 左边，各自标着「生产」「测试」这类环境标签。
  - 每条分支有自己的颜色，列表和图上一致；已合并的分支保留颜色并标出分支名。顶部分支栏挑要画哪些分支，默认全选。
  - 右侧详情一层层下钻：分支 → 提交 → 文件差异；环境 → 待部署、下一次发布会带上什么（可复制发布清单）、跳过了哪个环境、上线记录。
- **分支**：所有分支一张表——负责人、云端 / 本机状态、相对 dev 的领先 / 落后、走到了哪一站、PR（含 CI 与审核状态）、自定义标签。
  按「进行中 / 已进 dev / 已进 main / 停滞 / 可清理 / 本机 / 我的」筛选；「可清理」只生成删除命令，自己在终端执行。
- **成员**：每人一张卡（14 天节奏、手上的工作停在哪一站、名下的分支），点进去看详情：
  近 7 天的提交、待上线 / 没回合里有多少是 TA 的、每件工作展开到提交、每条分支进没进 dev / main。

数据一变（云端有新提交、环境换了版本、本机改了文件），页面自动刷新。

## 数据从哪来

| 数据 | 来源 | 回答什么 |
|---|---|---|
| 云端 | BranchMap 自己在缓存目录里的仓库副本（只有 Git 记录，没有代码文件），每 2 分钟同步一次；连了 GitHub App 时有人推送会立即同步 | 团队的真实进度：main / dev 现状、每个人推上去的分支 |
| 环境 | 对配置里的地址发只读 HTTP GET，读出正在运行的提交或版本号，每分钟一次 | 线上跑的到底是哪个提交 |
| 本机 | 扫描目录里的仓库和它们的所有工作树（只在本机跑时有） | 我推送了没有、拉取了没有 |
| GitHub | PR、CI、审核状态与头像：GitHub App 的只读授权，或者本机 `gh` 的登录 | 哪些在评审、CI 过没过 |

- 第一次建云端副本时，如果本机已经有这个仓库，会先从本机拷一份记录（很快，也不联网），再联网补齐。
- 同步用现有的 Git 登录（凭据管理器、SSH key），私有仓库也能读；连了 GitHub App 就用它的只读令牌。没有凭据时直接报错，不会弹登录窗口。
- 本机仓库只读：比较「推没推送」用的是云端副本，不会在你的仓库里执行 fetch。
- 服务只监听 `127.0.0.1`，并校验 `Host` / `Origin`。

## 用法

需要 Node 20+ 和 Git。

```bash
npm install
cp config.example.json config.json   # 改 scan（放仓库的目录）和各项目的环境
npm start                             # 启动并打开 http://localhost:4317/
```

`npm run serve` 只启动、不开浏览器，也可以在 VS Code 的内置浏览器里打开。

想看 PR、CI 和 GitHub 头像，二选一：

- 在「添加项目」里点「连接 GitHub」：GitHub 上会打开一个已经填好的「创建应用」页（权限全部只读），创建后选组织、勾仓库，回来就能勾选添加；
- 或者本机装一个登录过的 [GitHub CLI](https://cli.github.com/)（`gh auth login`）。

部署到服务器给团队看（反向代理、飞书登录、连接 GitHub、systemd 与 nginx 模板）见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 配置（config.json）

什么都不写也能用：只填 `scan`，扫到的仓库按远程地址自动归成项目，dev / main 自动识别。想看环境，给项目加 `environments`。

```jsonc
{
  "scan": ["C:\\Users\\me\\Projects"],          // 放仓库的目录，下面每个仓库和它的工作树都会被扫到
  "people": { "张三": ["Zhang San", "zhangsan"] },  // 同一个人的多个 Git 名字
  "projects": [
    {
      "remote": "https://github.com/acme/api.git", // 用远程地址对上项目；本机没有这个仓库也行，会直接联网建副本
      "name": "API",
      "group": "服务端",
      "flow": ["dev", "main"],                    // 主线分支的流向（不写就自动识别）
      "environments": [
        {
          "name": "测试",
          "branch": "dev",                        // 从哪条分支部署：环境会排在这条分支后面，并和它比较
          "url": "https://test.example.com",      // 给人点的链接
          "probe": { "url": "https://test.api.example.com/health", "commit": "commit" }
        }
      ]
    }
  ]
}
```

项目、主线分支和环境也可以在页面上改（「添加项目」、项目设置），会写回 `config.json`。

**环境怎么读出正在运行的提交**（`probe` + `resolve`）：

| 写法 | 适用 |
|---|---|
| `"probe": { "url": "…/health", "commit": "commit" }` | 接口直接返回提交号。字段可以写路径，如 `"build.sha"` |
| `"probe": { "url": "…/health" }` | 不写字段名：在返回的 JSON 里找 `commit`、`sha`、`gitSha`、`revision` 这类字段 |
| `"probe": { "url": "…/latest", "version": "version" }`，再加 `"resolve": [{ "tag": "app-{version}" }]` | 接口只返回版本号，按云端的标签找到提交 |
| `"resolve": [{ "manifest": "release/production/{version}/*/*.json", "field": "commit" }]` | 按本机打包留下的清单文件找提交（在这个项目的各个工作区里找） |

- 读不出提交的环境照样显示，状态是「版本未知」。流水线会跳过它，直接比较前后能判断的两站，比如 dev → main。
- 最稳的做法是让服务的健康接口返回构建时的提交号（构建时写进镜像，接口原样返回）。

**其他可选项**：

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | 4317 | 端口 |
| `syncInterval` | 120 | 云端同步间隔（秒） |
| `probeInterval` | 60 | 环境探测间隔（秒） |
| `localInterval` | 90 | 本机重扫间隔（秒），切回页面时也会扫一次 |
| `windowDays` | 21 | 在途工作的时间窗；没上线的不受限 |
| `health.staleDays` | 30 | 分支多久没动算停滞 |
| `health.backlogDays` | 7 | 待上线的提交等多久提示积压 |
| `health.envLagHours` | 24 | 环境落后它的分支多久提示该部署 |
| `tickets` | 自动 | 工单号：`{ "prefixes": ["ABC"] }` 或 `{ "pattern": "…" }`，`url` 可写 `"https://…/{id}"`。不写时自动识别：同一前缀出现过 3 个以上编号就算工单 |
| `auth` | 不开 | 部署到服务器时的飞书登录，见 [docs/DEPLOY.md](docs/DEPLOY.md) |

## 健康检查

| 规则 | 级别 |
|---|---|
| 云端从来没同步成功过 | 严重 |
| 环境离线 | 严重 |
| 云端同步失败超过 15 分钟 | 注意 |
| 环境运行的提交不在任何分支（用没推送的代码部署的） | 注意 |
| 环境运行的代码里有不在它分支上的提交（从别处部署的） | 注意 |
| 上线分支有前一个环境没验证过的提交；后一个环境有、前一个环境没有的提交（跳过了测试） | 注意 |
| 没回合：main 上有不在 dev 的提交 | 注意 |
| 待上线的提交等了超过 `backlogDays`；环境落后它的分支超过 `envLagHours` | 注意（没超过时是提示） |
| 环境版本未知、分支停滞、本机运行的环境没在跑 | 提示 |

本机的情况（未推送、未提交）不算项目的健康，在看板的「本机」和分支页的「本机」筛选里看。

## 代码结构

```
server.mjs              HTTP 接口、实时推送（SSE）、静态页面、连接 GitHub 与 Webhook
lib/config.mjs          读配置
lib/sources/            三个数据源，互不依赖
  cloud.mjs               云端副本：建、同步、状态
  local.mjs               本机扫描：工作区、本地分支、和云端比
  env.mjs                 环境探测：读提交 / 版本，按标签或清单找提交
lib/engine/             纯计算，不碰磁盘和网络
  graph.mjs               提交图（位图可达性）
  pipeline.mjs            流水线：站、差距、在途工作、分支、成员
  health.mjs              健康规则（每条一个函数，往 RULES 里加）
lib/project.mjs         把三个数据源接到引擎上，调度后台任务，数据变了就通知页面
lib/repo.mjs            云端副本上的 Git 查询（提交图、提交、差异、对比、PR）
lib/git.mjs             运行 git：只读、限并发，联网命令单独排队且不弹登录窗口
lib/people.mjs          把「名字 + 邮箱」归成人，头像来自 GitHub
lib/github.mjs          连接 GitHub：App 的创建与安装、令牌、已授权的仓库、Webhook 校验；没连时退回本机 gh
lib/remote.mjs          远程地址的各种写法统一成一个键（用来对上项目）
lib/auth.mjs            部署到服务器时的飞书登录（本机不开），见 docs/DEPLOY.md
web/                    页面（原生 JS 模块，不需要构建）
deploy/                 服务器部署模板：systemd 服务、nginx 站点
scripts/check-docs.mjs  文档治理闸（npm run check:docs）
```

工程约定（Git、issue、文档治理、界面文案）见 [AGENTS.md](AGENTS.md)，文档索引见 [docs/README.md](docs/README.md)。

加一种数据源（比如工单系统），就在 `lib/sources/` 加一个模块，在 `project.mjs` 里接上。加一条健康规则，就往 `health.mjs` 的 `RULES` 里加一个函数。
