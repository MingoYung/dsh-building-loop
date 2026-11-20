# Building-loop 0.7.50

0.7.50 将正式桌面已用的子会话派发修正带入公开主线，并适配 Windows DSH NEXT `2.0.24-next`（内核 `0.2.2-rc.5`）。已从该宿主的真实会话验证开工后的执行方、两道审核交接、等待用户以及重启恢复。

## 安装包

从 [GitHub Release 下载安装包](https://github.com/MingoYung/dsh-building-loop/releases/download/v0.7.50/dsh-building-loop-0.7.50.tgz)。在 DSH 的「插件 → 添加插件」选择下载的文件，或者在 DSH NEXT 内置终端对目标 Profile 执行下列命令。

```powershell
dsh plugin --profile desktop add https://github.com/MingoYung/dsh-building-loop/releases/download/v0.7.50/dsh-building-loop-0.7.50.tgz
```

安装包为 **647,609 字节**，SHA-256 为 `255256381e3b6b92bb365d0a1d3a3f475f53c33f91e7fc19287eb00c27f9df9e`。发布页同时提供逐文件摘要。

## 哪些行为经过验证

| 用户遇到的情形 | Windows 实测结果 |
| --- | --- |
| 确认开工后等执行方 | 旧公开 0.7.39 在新宿主上收到确认后未能启动执行方。0.7.50 在同一场景中成功派出。 |
| 待首审、待独立终审 | 宿主分别派给两个不同的审核会话。缺少独立证据时，提前提交终审会被拒绝。 |
| 正在等用户答复 | 等待期间新增子会话和子会话轮次均为 0，用户答复后恢复派发。 |
| 写下交接前后强制退出 | 三次强退覆盖待派、已送达和已预留编号三个时点。恢复后沿用同一审核会话与交接编号。 |
| 与已有桌面插件共存 | 从正式 Profile 的冻结依赖在 G 盘演练升级和回退，逐项核对另外 18 个直接依赖、补丁与锁文件。 |

与正式 0.7.39 兼容包逐文件比对，57 个文件字节一致，另外两个是包清单和首页。构建协议锁定到 rc.5，重新构建校验也通过。此前从源码打包会把实验数据、测试和开发工具带进安装包，本次将 1,549 个条目收至 59 个。完整实验仍可从仓库查阅。

本轮用真实 Windows 宿主和本地脚本化回复驱动相同会话。历史 DeepSeek Flash 的任务成绩继续按原版本归档。[本轮原始观测摘要](../experiments/observations-0.7.50-dsh-next.json) · [0.7.39 能力基线](release-0.7.39.md)
