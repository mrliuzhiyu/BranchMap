# TODOS

> 小改动列这里。多文件改动 / 需要诊断的走 [issues/](issues/README.md) 流程。
>
> 三类东西进这里：
> 1. **单文件小改 / 文案 / 依赖升级**——不值得开 issue 的
> 2. **issue 归档时摘出的非代码活**——部署、服务器配置、飞书后台配置。归档 ≠ 做完，不摘出来就会被埋掉
> 3. **顺手发现、这次没做的疑点**——写清在哪、怎么核实，不要顺手扩大当次改动
>
> 做完的直接删掉这一行（Git 里有历史），不留勾选的项。

## 待核实

- [ ] **`web/lib/model.js` 还有一批没人调用的老方法**：`trunkRelation`、`syncState`、`groupByChain`、`authorsOf`、
  `groupLabel`、`bodyTitle`、`prOf`、`containedIn`、`resolve`、`baseB`（页面外没有任何调用，只互相调用）。
  分支状态、主线差异早已改由服务端 `lib/engine/pipeline.mjs` 算。删之前再 grep 一遍确认没有新调用方。
  （2026-10-07 删「停滞 14 天」那条死路径时发现）

## 部署

- [ ] **服务器上连接 GitHub**：飞书登录后在「添加项目」里填 `siltok-ai`、点「连接 GitHub」，创建并安装 App、勾选仓库（需要组织 owner）。
  走通后验收 [issues/open/20261007-github-app-connect.md](issues/open/20261007-github-app-connect.md) 的 AC-5。
- [ ] **服务器的飞书门禁收尾**：第一次飞书登录后从服务日志取 `tenant_key` 填进 `auth.tenantKey`，`auth.admins` 换成管理员的飞书 open_id。

## 开源

> 2026-10-09 仓库已公开（https://github.com/mrliuzhiyu/BranchMap）。公开前按用户要求改写了全部历史，去掉部署服务器的 IP 与域名，
> 强制推送后发现 GitHub 仍能按旧提交号访问被覆盖的提交，于是删掉旧仓库、同名重建只推干净历史（用户授权）。
> 所以本仓文档和提交说明里引用的 2026-10-09 之前的提交号（如 `db49310`、`fc3a069`）都已不存在。
> 原始历史备份在用户电脑上（JoySpace 目录下的 bundle 文件），不在仓库里。提交作者邮箱仍是原邮箱。

- [ ] **许可证**：仓库还没有 LICENSE（用户 2026-10-09 说先不管）。没有许可证时代码公开了别人也不能合法使用；公开前定下（MIT / Apache-2.0 / AGPL-3.0），加 `LICENSE` 并在 `package.json` 写 `license`。
- [ ] **README 截图**：现成能截的只有公司仓库（提交说明、同事名字），不能用；准备一个演示仓库再截看板、分支图、成员页。
- [ ] **英文的 CONTRIBUTING / SECURITY**：别人提 PR、报漏洞要看。安全说明至少写清：本机模式没有登录、只听 127.0.0.1；服务器模式靠飞书门禁；「测试探测地址」只有管理员能调（防 SSRF）。
