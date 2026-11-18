# 分块索引 · 文件与接手

上级为[项目总纲](../README.md)。本块维护三级导航、现行文件、逐文件更新日志和备份。项目指定各层维护人。

| 想做什么 | 读哪份正文 |
|---|---|
| 新建项目、接手或插入新内容 | [项目索引契约](../skills/project-index/SKILL.md) |
| 更新受保护章节、增加模块并同步三层 | [受控项目结构](../governance/project-hierarchy.md) |
| 发布前核对登记范围、文件哈希和逐文件日志 | 在仓库根运行 `npm run check:index`，依次使用[发布文件清单检查](../scripts/check-index-coverage.mjs)和 [PowerShell 7 校验器](../skills/project-index/check.ps1) |
| 核对本仓库所登记的文件 | [机器索引](../INDEX.json) |
| 查某个文件改过什么 | [逐文件日志](../changes/) |

例如深挖一次加载失败，一级登记问题、范围和状态，二级定位当前故障分块及负责人，三级放诊断记录、实现与原始日志定位。接手时沿这条路径走，只打开本轮需要查的正文。

推送发布分支前运行同一检查，`npm publish` 也会自动运行。Git 已跟踪的项目正文，以及 `package.json` 发布清单目录中待加入的新文件，都要登记。机器索引自身用 Git 和[专属日志](../changes/INDEX.json.md)追踪，逐文件日志由校验器按正文路径查找。原始实验归档通过 [data/index.json](../experiments/data/index.json) 进入，子目录由归档清单维护。
