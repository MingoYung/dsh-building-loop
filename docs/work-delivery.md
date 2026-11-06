# 分块索引 · 派单与交付

上级为[项目总纲](../README.md)。本块维护 DSH 模式入口、任务交接和验收约定。项目指定总控、执行和验收人。

| 想做什么 | 读哪份正文 |
|---|---|
| 看 DSH 预设、工具和模式约束 | [预设配置](../cordis.patch.yml) |
| 派单、接单、复用会话、处理阻塞 | [派单协议](../skills/dispatch-protocol/SKILL.md) |
| 查询和核对断言出处 | [证据核验约定](../skills/dispatch-protocol/references/evidence.md) |
| 检查根会话被截断时如何续轮 | [续轮插件](../turn-resume/index.mjs) |
| 检查安装、技能根或上游许可 | [包清单](../package.json) · [禁用技能根](../skills-disabled/README.md) · [DeepSeek Harness MIT 许可](../LICENSES/DeepSeek-Harness-MIT.txt) |

例如同一模块需要二次补查，总控给原执行会话发任务号和新证据位置。核验方指出具体哪个断言与出处不符。总控收回执、更新进度，正文由执行方修订。
