---
status: active
type: reference
verified: 2026-10-07
---

# 文档索引

> 工程优先：先核对代码和实际运行结果，文档只提供线索。治理规则见 [DOC_GOVERNANCE.md](DOC_GOVERNANCE.md)。
> 本索引登记 `docs/` 全部现行文档，新增文档须在此登记一行；下表的 status / type / verified 必须与文档自身一致，
> 不一致时 `npm run check:docs` 直接报错。

项目是什么、怎么跑、怎么配、代码结构：见仓库根目录 [README.md](../README.md)。
给 agent 的指令与产品约定：见 [AGENTS.md](../AGENTS.md)。

## 现行文档

| 文档 | status | type | verified | 内容 |
|---|---|---|---|---|
| [DOC_GOVERNANCE.md](DOC_GOVERNANCE.md) | authoritative | spec | 2026-10-07 | 文档治理：放什么、状态头、归档、issue 流程、个人记忆与仓库文件的分工、文档闸 |
| [DEPLOY.md](DEPLOY.md) | active | guide | 2026-10-07 | 本机与服务器两种跑法、上服务器的步骤（反向代理、飞书应用、机密、连接 GitHub App、Git 凭据）、`deploy/` 模板与已部署环境登记表 |

## 归档

过期文档在 `docs/archive/`（目前为空），冻结保存，不登记、不维护。
