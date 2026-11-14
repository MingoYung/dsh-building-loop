# building-loop 0.4.0 来源核验与账本实测

2026-11-07 北京时间。DSH 0.2.2-rc.1，官方 deepseek-flash，4096 输出上限。合成样例沿用 19/20 功能计数和 120 ms → 96 ms 耗时。两组只改变补查续派方式。

## 实际验证

- 两组都从缺源退回、补查、独立核验走到事实通过，然后经过账本复盘关单。实际读取清单由宿主生成，原文与登记的 synthetic 来源摘要一致。
- 真实工具入口分别尝试虚报读过首审回执、跳过账本读取直接关单，两组各两个探针全部拒绝。每组另有 14 项原生工具探针，模型各自也尝试五类越界工具，均按权限拒绝。
- 九项确定性回归通过，包含额外编号与未编号断言、来源版本替换、质量退回、账本遗漏、现状变更、默认单元关联和原样重试。

| 组别 | 全流程 Token | 缓存命中率 | 墙钟秒 | 阶段派发 |
|---|---:|---:|---:|---|
| 复用 | 1,003,283 | 96.32% | 135.6 | {'intake': 1, 'first-review': 1, 'supplement': 1, 'final-review': 1} |
| 新开 | 1,218,351 | 96.74% | 162.7 | {'intake': 1, 'first-review': 1, 'supplement': 1, 'final-review': 1} |

Token 包含缓存输入和输出。这次验证增加来源凭据与账本复盘，每组一次，属于流程验收记录。

## 按现状处置账目

| 账目 | 复用组 | 新开组 |
|---|---|---|
| future-sampling | pending · PROJECT.md:4 明确「后续扩大采样的计划仍有效」，且终审回执 records/audit-final.json:64、:84 指出 timing.csv 未给原始样本数与离散度，需后续采样补充。 | pending · PROJECT.md:4「后续扩大采样的计划仍有效」；本轮仅单对均值对比，不覆盖此计划，保留待后续采样单元。 |
| temporary-layout | covered · PROJECT.md:4 写明「旧排版计划已被当前候选格式覆盖」，且终审回执 records/audit-final.json:6 记录了修订后候选 sha256，现行格式已生效。 | obsolete · PROJECT.md:4「旧排版计划已被当前候选格式覆盖」；终审候选 sha256 3137e3c0…（records/audit-final.json:6）已定稿，旧排版无遗留价值。 |
| paused-chart | obsolete · PROJECT.md:5 写明「当前项目已取消图表页面，原来搁置的图表任务已失去本轮意义」，无重新开启的依据。 | obsolete · PROJECT.md:5「当前项目已取消图表页面，原来搁置的图表任务已失去本轮意义」；本轮终审交付与计算项也不含任何图表内容（records/audit-final.json:41-62）。 |
| unit-K01 | completed · K01 首审退回后经补查修订，终审 decision=accept、unsupported 为空（records/audit-final.json:5-8），已具备关单条件。 | completed · 终审 decision=accept（records/audit-final.json:5），unit=K01（:2），候选 3137e3c0…（:6）已验收，工作单元结单。 |

## 预跑与修正

042005Z 的复用组已完成，首次新开组在全局读取未关联单元的接口问题上空转并停在账本阶段。修复为在仅有一个本总控待复盘单元时自动关联，同时补上明确的错误指引和重复提交处理。本记录对应修复后的 042819Z。前一次全部事件和已记录用量也归档。

[计算明细](data/building-loop-evidence-audit/20261107T042819Z.json) · [原始事件](data/building-loop-evidence-audit/20261107T042819Z.json) · [确定性回归输出](data/building-loop-evidence-audit/20261107T042819Z.json) · [复用账本](data/building-loop-evidence-audit/20261107T042819Z.json) · [新开账本](data/building-loop-evidence-audit/20261107T042819Z.json)

外部发布者的身份、采样口径和材料能否支持普遍结论仍要核原始来源与领域证据。原文摘要用于绑定版本，synthetic 标记明确当前来源属于合成样例。


## 与前一版样例的用量对照

| 组别 | 0.3.1 全程 Token | 0.4.0 全程 Token | 观测变化 |
|---|---:|---:|---:|
| 复用 | 718,263 | 1,003,283 | +39.68% |
| 新开 | 706,533 | 1,218,351 | +72.44% |

0.4.0 增加了来源凭据与五至六条账目处置，任务输入和验收要求也有相应变化。本次对照用于说明实耗和机制行为。
