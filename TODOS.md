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

- [ ] **129 上连接 GitHub**：飞书登录后在「添加项目」里填 `siltok-ai`、点「连接 GitHub」，创建并安装 App、勾选仓库（需要组织 owner）。
  走通后验收 [issues/open/20261007-github-app-connect.md](issues/open/20261007-github-app-connect.md) 的 AC-5。
- [ ] **129 的飞书门禁收尾**：第一次飞书登录后从服务日志取 `tenant_key` 填进 `auth.tenantKey`，`auth.admins` 换成管理员的飞书 open_id。
