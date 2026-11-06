# building-loop

DeepSeek Harness 的 Agent 预设，沿用 `agent-building-loop` 对职责、输入输出和验证的约定。跨会话工作使用任务单和回执。会话从工作区 `AGENTS.md` 和可选的 `DISPATCH.md` 取得项目规则。

派单方先明确工作范围、交付物和验收标准，再决定哪些单元适合委派。接单方直接执行收到的单元，任务单明确授权时才继续委派。单一小任务或串行步骤可以留在当前会话执行。

## 安装

兼容基线为 DeepSeek Harness `0.2.2-rc.1`，对应 DSH NEXT `2.0.22-next`。在 DSH 终端安装。

```powershell
dsh plugin --profile desktop add github:MingoYung/building-loop
```

应用插件后，在空白会话的模式列表中选择 **building-loop**。本地开发时，可以把命令里的 GitHub 地址换成本仓库的路径。对于已手写同 ID 预设的 Profile，安装前先核对预设声明，避免注册重复 ID。

## 内容

- `cordis.patch.yml` 声明预设、工具和会话指令。
- `skills/dispatch-protocol/SKILL.md` 定义任务单、回执、工作单元状态和验收规则。
- `skills/project-index/` 提供项目索引契约与 PowerShell 7 校验脚本。
- `turn-resume/index.mjs` 在根会话因输出上限截断时排下一轮续写，默认最多连续三次。

项目可以在自己的 `DISPATCH.md` 里约定记录位置和编号。任务的工作范围与验收依据由任务单给出。

预设的部分工具编排沿用 DeepSeek Harness 发布的配置。[上游 MIT 许可](LICENSES/DeepSeek-Harness-MIT.txt)
