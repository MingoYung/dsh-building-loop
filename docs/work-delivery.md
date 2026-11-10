# 分块索引 · 派单与交付

上级为[项目总纲](../README.md)。本块维护 DSH 模式入口、任务交接和验收约定。项目指定总控、执行和验收人。

| 想做什么 | 读哪份正文 |
|---|---|
| 看 DSH 预设、工具和模式约束 | [预设配置](../cordis.patch.yml) |
| 设置文件授权与阶段 | [项目配置和工具说明](../governance/README.md) · [宿主机制](../governance/index.mjs) · [路径与权限检查](../governance/policy.mjs) |
| 检查退回项、数字复算和交付质量 | [提交预检](../governance/preflight.mjs) |
| 核全文覆盖、概念一致和逐条推导 | [规则与边界](../governance/full-coverage.md) · [覆盖与证明实现](../governance/coverage.mjs) · [覆盖回归](../test/coverage.test.mjs) |
| 降低调用浪费、核共同误判或设置滚动交接 | [调用成本与交接机制](../governance/efficiency.md) · [成本与边界回归](../test/efficiency.test.mjs) |
| 核实际读取、来源凭据与每轮账本复盘 | [核验与账本](../governance/verification.md) · [来源检查](../governance/evidence.mjs) · [目标版本](../governance/goals.mjs) · [账本机制](../governance/ledger.mjs) |
| 复跑权限和提交回归 | [文件权限测试](../test/governance.test.mjs) · [补查预检测试](../test/preflight.test.mjs) · [真实失败修复回归](../test/repairs.test.mjs) · [隔离测试设施](../test/helpers.mjs) |
| 继续本插件的后续改进 | [本项目任务账本](task-ledger.md) |
| 派单、接单、复用会话、处理阻塞 | [派单协议](../skills/dispatch-protocol/SKILL.md) |
| 查询和核对断言出处 | [证据核验约定](../skills/dispatch-protocol/references/evidence.md) |
| 检查根会话截断续轮与 DeepSeek 工具参数重试 | [恢复规则](../governance/efficiency.md) · [运行入口](../turn-resume/index.mjs) |
| 检查安装、技能根或上游许可 | [包清单](../package.json) · [禁用技能根](../skills-disabled/README.md) · [DeepSeek Harness MIT 许可](../LICENSES/DeepSeek-Harness-MIT.txt) |

例如同一模块需要二次补查，总控根据退回回执推进。宿主把补查权限绑定给原执行会话后唤醒它。正文由执行方修订，核验方回查原始证据，总控凭落盘回执更新进度。
