# 分块索引 · 资料核验与任务账本

上级为[项目总纲](../README.md)。[授权配置](README.md)定义文件范围。[宿主入口](index.mjs)负责阶段流转，[来源检查](evidence.mjs)负责实际证据，[任务账本](ledger.mjs)负责下一轮工作复盘。

## 资料的三层核对

1. **实际观察。** 读取工具记录本轮文件、原文范围和摘要。`sourceRefs` 必须对应实际观察，回执的 `actualReads` 和 `observedSources` 由宿主生成。来源说明涉及本轮未读的文件时拒绝提交，待核资料单列 `unverifiedSources`。
2. **原始来源与版本。** 项目维护者可在授权清单的 `sourcePins` 按文件登记 `sha256`、`kind`（`primary`、`secondary`、`synthetic`）和 `locator`。单元启用 `requireSourcePins` 后，原文必须与登记版本相符。无凭据的旧项目沿用本地已读证据，并在回执中标为 `unregistered`。来源登记本身要有取得原文和确认归属的依据。
3. **结论与边界。** 候选新增的 `C数字` 编号也进入必验清单。核验方通过 `unlisted` 登记未编号、尚需查证的事实，退回后原句仍保留会被补查预检拦住。出处是否支持结论、独立性、反例和适用范围由独立核验判断。固定公式由[预检模块](preflight.mjs)重算。

文件摘要用于定位版本。资料的上游真实性要核发布者、原始获取途径和适用口径。合成样例的来源类型会如实保存，验收范围限于对应样例。

## 账本与每轮复盘

`building_loop_ledger` 提供 `record`、`read`、`review`。总控可登记 `planned` 后续计划、`temporary` 临时需求、`interrupted` 搁置事项。直接用户消息按事件引用自动登记为待判定条目，派单与中断也自动记账。消息原文保留在 DSH 事件记录，账本保留摘要、来源和处置依据。

每轮流程如下。

```text
派单 → 接单 → 首审 → 按需补查和终审 → 事实通过
    → ledger-review → 读最新账本和项目现状 → 逐项判断 → closed
```

项目可在授权清单中配置 `ledgerContext`，最多三份，总控必须有读权。账本复盘阶段要读取这些文件及本轮验收回执。对全部未结事项选择 `keep` 保留、`resume` 待续做、`defer` 延期、`completed` 完成、`covered` 已被覆盖或 `obsolete` 已失效。每项都要原因，后三项必须给本轮实际读过的原文路径和行号。本轮单元的完成必须以本轮通过回执为据。

账本变更后要重新读取，现状材料变更后要重读依据。全局读取在仅有一个本总控待复盘单元时自动关联该单元，也可显式提供 `unit`。同一次已成功复盘的原样重试返回先前结果。该检查与工作单元状态共用一个加锁、原子写入的宿主文件，并保留一份 `.bak` 改前快照，数据位于 DSH_HOME 的 `building-loop-state/`。用 `includeClosed=true` 可查看已处置事项。

中断保留原会话和原因，其他单元可继续。某个搁置单元被当前成果覆盖或失效时，原总控可以凭本轮依据结束其执行资格，保留 `retired` 记录。账本记录与执行权限分别受控。

## ClearAI 对照与取舍

本轮核对了本机 `clearai-dsh 0.5.8` 的验证文档，以及 `audit-evidence.js`、`audit-material.js`、`integrity.js` 的实现。采用的设计原则是分开观测与判断、让独立核验逐项给依据、用材料摘要绑定裁决版本、材料异常时停止可信推进。building-loop 的来源检查与账本代码在本仓库实现。

0.3.1 的实验没有完成这份对照，本轮作为后续改造依据登记。ClearAI 的 L2/L3/L4 和领域检验设计更广，本模式当前使用文件范围、已读记录、来源凭据、逐项核验和任务复盘处理项目长任务。[ClearAI 验证路线](https://github.com/Clearailhc/clearai-dsh/blob/v0.5.8/docs/verification-loop.zh-CN.md) · [来源引用实现](https://github.com/Clearailhc/clearai-dsh/blob/v0.5.8/preset/plugins/audit-evidence.js) · [材料摘要实现](https://github.com/Clearailhc/clearai-dsh/blob/v0.5.8/preset/plugins/audit-material.js) · [0.5.8 发布记录](https://github.com/Clearailhc/clearai-dsh/releases/tag/v0.5.8)
