# building-loop

DeepSeek Harness 的 Agent 预设。用三级文件保存项目现状，用授权清单限定文件和角色。宿主在派单、接单、补查和验收前提供对应规则，并用落盘回执推进工作单元。

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

项目维护者先从[派单分块索引](docs/work-delivery.md)查看授权示例，在工作区根创建 `BUILDING-LOOP.json`，再开会话。清单缺失时受控文件工具会拒绝访问。
