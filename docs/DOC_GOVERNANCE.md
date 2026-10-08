---
status: authoritative
type: spec
verified: 2026-10-07
note: 抄自 siltok_web 的 docs/DOC_GOVERNANCE.md（2026-09-23 版），去掉五仓同步与 Multica
---

# 文档治理

> BranchMap 只有一个仓，任务、决策与验收证据都在本仓：`issues/` 记非平凡改动，`TODOS.md` 记小事。
> 规则来源是 Siltok 五仓统一的文档治理，判据与 `scripts/check-docs.mjs` 保持一致；改规则先改这里，再改脚本。

## 一、判断现状以工程为准

- 先核对代码、实际配置和运行结果，文档只是线索。
  文档经常滞后：部署上线、密钥注入、外部账号接通这类事都不伴随代码改动，没有机制提醒人回来改文档。
- 发现文档与代码不符，以代码为准，并顺手把文档订正回来，写明滞后了多久。
- `authoritative` 只说明这份文件的用途，不保证内容仍然正确。
- 历史方案、空 checkbox、「未提交」字样不能自动变成开发需求。
- 完成按用户请求和工程验证判断；提交、推送、部署各自需要明确授权。

## 二、仓库里放什么

| 位置 | 放什么 | 不放什么 |
|---|---|---|
| `AGENTS.md` | 给 agent 的工程指令与用户定下的产品约定，唯一真源 | 规范全文（链过去） |
| `CLAUDE.md` | 只有一行 `@AGENTS.md` | 任何其他内容 |
| `README.md` | 项目是什么、怎么跑起来、怎么配 | 进度、决策记录 |
| `docs/` | 现行的规则、边界、手册（部署等） | 已被取代的计划、阶段评估 |
| `docs/archive/` | 过期文档，冻结保存 | 仍在用的东西 |
| `issues/` | 非平凡改动的诊断、验收标准与验收证据 | 长篇讨论 |
| `TODOS.md` | 单文件小改、归档时摘出的非代码活、待核实的疑点 | 已完成事项、长篇说明 |

**个人记忆**（`~/.claude/projects/…/memory/`）只在这台机器、这个账号下可见。
用户定下的、别人写代码也要遵守的规则，写进 `AGENTS.md`；记忆里可以留一份作兜底，但不能只存在记忆里。
记忆里写着「待做」的事，动手前先查代码是否已经做了。

## 三、`docs/` 的状态头（强制）

```yaml
---
status: active        # authoritative / active / draft / historical / superseded
type: guide           # spec / guide / reference / roadmap / research / progress
verified: 2026-10-07  # 最后一次真实核对内容的日期
# superseded_by: 相对路径   ← status 为 superseded 时必填
---
```

| status | 含义 |
|---|---|
| `authoritative` | 不变量 / 契约，冲突时仍要按第一节核对工程 |
| `active` | 当前在用，会演进 |
| `draft` | 规划，**未实施**，不能当现状 |
| `historical` / `superseded` | 只作溯源；应当移进 `docs/archive/` |

`type` 决定多久没核对算过期（只报警）：spec 365 天 · reference / guide 180 · roadmap 120 · research 90 · progress 60。
`authoritative` / `historical` / `superseded` 不报过期。

`verified` 只在真的核对过内容后改，**不批量刷日期冒充核验**。
额外字段统一用这几个名字：`id` · `owner` · `note`（一句话的进度或阶段说明）。
不要在正文另写一份「状态：」行——同一个事实两处维护必漂。

**每份现行文档都要在 `docs/README.md` 登记一行**；登记行若写了 status / type / verified，必须与文档自身一致。

## 四、归档

文档**过期了就移进 `docs/archive/`**，不原地挂横幅：

1. `git mv docs/xxx.md docs/archive/xxx.md`
2. 从 `docs/README.md` 的现行表里删掉那一行
3. 修掉现行文档里指向它的链接（改指新文档，或删掉）

归档区是冻结的：不要求状态头、不登记、不查链接、不再修改。要恢复就移回来并补齐状态头。
重复或毫无价值的内容可以直接删，Git 里有历史；**未跟踪的唯一资料不能删**。

## 五、非平凡改动：`issues/`

**走 issue**：bug 修复 · 多文件改动 · 架构调整 · 安全修复。
**不走**：单文件小改 · 文案 · 样式微调 · 依赖升级 → 记 `TODOS.md`，或直接改。

`issues/open/YYYYMMDD-slug.md` 按 [issues/TEMPLATE.md](../issues/TEMPLATE.md) 写，四步：

1. **问题**：现象 → 原则（违反了什么）→ 方案（选什么、为什么不选别的）→ 改动范围。状态 `🔍 诊断中`
2. **验收标准**：每条带 checkbox、检查命令、通过标准、证伪路径。状态 `📋 待实现`
3. **实现记录**：记为什么，不记改了什么（diff 里有）。状态 `🔧 实现中`
4. **验收结果**：勾选全过 → `git mv` 到 `issues/done/` + 挪 `issues/README.md` 索引行，状态 `✅ 已验收`。
   被取代而关闭的用 `🗄️`。归档时把非代码活（部署、服务器配置、飞书后台配置）摘进 `TODOS.md`

`issues/README.md` 一条 issue 只占一行（标题 · 一句话 · 状态 · 日期），细节留在文件里。

界面改动的验收标准里，「在真浏览器里看过」是合法的检查方式，写清看哪一页、什么状态、期望看到什么。

## 六、闸

```bash
npm run check:docs      # 即 node scripts/check-docs.mjs
```

ERROR（退出码 1）：`AGENTS.md` / `README.md` / `TODOS.md` / `docs/README.md` / 本文件缺失 ·
`CLAUDE.md` 不是一行指针 · 缺状态头 / 值非法 ·
`docs/` 孤儿、失链、索引漂移、重复登记 · `issues/` 孤儿、失链、表错位、状态符号不一致、
做完（✅/🗄️）却还在 `open/`、文件名不是 `YYYYMMDD-slug.md` ·
全仓 Markdown 本地链接失效（`docs/archive/`、`issues/done/` 除外）。
WARN：`verified` 过期或缺失：核实后改日期，或者归档。

闸只保证结构，**不证明内容正确**。
