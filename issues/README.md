# Issue 跟踪

> 规则见 [docs/DOC_GOVERNANCE.md](../docs/DOC_GOVERNANCE.md) 第五节。
> 小改动直接记 [TODOS.md](../TODOS.md)。多文件改动 / 需要诊断的问题走这里。
> 模板：[TEMPLATE.md](TEMPLATE.md) ｜ 流程：问题（原则 / 方案 / 改动范围）→ 验收标准 → 实现 → 验收

## 语义边界

`open/` 记录仍需推进的问题，`done/` 保留已验收或已归档的历史记录。
文件名日期只用于定位来源，不决定问题是否仍存在。判断现状先查代码和最近一次对应验收。

| 目录 | 含义 |
|---|---|
| `open/` | 进行中（🔍 诊断中 / 📋 待实现 / 🔧 实现中） |
| `done/` | 已验收（✅）或被取代（🗄️），历史快照，不再修改 |

**一条 issue 在下表只占一行**：标题 + 一句话 + 状态 + 日期。细节留在 issue 文件里，不要把实现记录抄进索引。
归档要三件事一起做：改文件的状态头、`git mv` 到 `done/`、把索引行挪到「已归档」表，漏一件 `npm run check:docs` 会报错。

## 进行中

| Issue | 一句话 | 状态 | 日期 |
|---|---|---|---|
| [界面文案整理：学 Dash](open/20261008-copy-cleanup.md) | 716 条文案按 Dash 规范收成状态名，定词表写进 AGENTS.md；去掉「点击…」类操作说明与成因长句 | 🔧 实现中 | 2026-10-08 |
| [连接 GitHub：GitHub App 授权读仓库](open/20261007-github-app-connect.md) | 网页上点「连接 GitHub」创建并安装 App，勾选授权的仓库；PR / CI / 头像走 App，Webhook 实时同步，不再依赖 gh | 🔧 实现中 | 2026-10-07 |

## 已归档

| Issue | 一句话 | 状态 | 日期 |
|---|---|---|---|
| [引入 Siltok 的工程治理](done/20261007-adopt-doc-governance.md) | AGENTS.md 唯一真源、issues 四步、TODOS、docs 状态头与文档闸；产品约定从个人记忆搬进仓库并写明完成情况 | ✅ 已验收 | 2026-10-07 |
