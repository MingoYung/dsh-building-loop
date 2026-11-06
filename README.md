# building-loop

DeepSeek Harness 的 Agent 预设。用三级文件保存项目现状，用任务单和回执组织执行、追查来源和验收。项目规则从工作区的 `AGENTS.md` 和可选的 `DISPATCH.md` 读取。

## 分块入口

| 分块 | 进入条件 | 索引 |
|---|---|---|
| 项目文件与接手 | 新项目、深度问题、恢复上下文、改档 | [文件与接手](docs/project-files.md) |
| 派单、核验与交付 | 发任务、收回执、续做、验收 | [派单与交付](docs/work-delivery.md) |

接手时先看本页，选择相关分块，从分块索引读正文。项目自定总纲、分块负责人和台账位置。仓库的机器索引用 `INDEX.json` 对账，逐文件变更见 `changes/`。

## 安装

兼容基线为 DeepSeek Harness `0.2.2-rc.1`，对应 DSH NEXT `2.0.22-next`。在 DSH 终端安装。

```powershell
dsh plugin --profile desktop add github:MingoYung/dsh-building-loop
```

安装 `dsh-building-loop` 后，在新会话的模式列表中选 **building-loop**。本地开发可将安装地址换成本仓库路径。从旧包 `building-loop` 迁移时，先从同一 Profile 移除旧包，再安装新包。两者使用同一个预设 ID。
