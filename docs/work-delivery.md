# 分块索引 · 派单与交付

上级为[项目总纲](../README.md)。本块维护 DSH 模式入口、任务交接和验收约定。项目指定总控、执行和验收人。

| 想做什么 | 读哪份正文 |
|---|---|
| 看 DSH 预设、工具和模式约束 | [预设配置](../cordis.patch.yml) |
| 设置文件授权与阶段 | [项目配置和工具说明](../governance/README.md) · [宿主机制](../governance/index.mjs) · [路径与权限检查](../governance/policy.mjs) |
| 复跑文件安全回归 | [Node 测试](../test/governance.test.mjs) |
| 派单、接单、复用会话、处理阻塞 | [派单协议](../skills/dispatch-protocol/SKILL.md) |
| 查询和核对断言出处 | [证据核验约定](../skills/dispatch-protocol/references/evidence.md) |
| 检查根会话被截断时如何续轮 | [续轮插件](../turn-resume/index.mjs) |
| 检查安装、技能根或上游许可 | [包清单](../package.json) · [禁用技能根](../skills-disabled/README.md) · [DeepSeek Harness MIT 许可](../LICENSES/DeepSeek-Harness-MIT.txt) |

例如同一模块需要二次补查，总控根据退回回执推进。宿主把补查权限绑定给原执行会话后唤醒它。正文由执行方修订，核验方回查原始证据，总控凭落盘回执更新进度。
