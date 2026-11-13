# 0.7.29 · R73 架构核验、回退演练及诊断

上级为[实验索引](README.md)。沿用 [0.7.28 冻结原稿及短提示](results-0.7.28.md)。本轮使用隔离的 Windows DSH、现有受信签名工具和 WSL 隔离运行器，正式 DSH 放行取决于真实模型短关及后续盲测。

## 冻结稿和宿主回归

| 检查 | 错例 | 正例及验收 |
|---|---|---|
| 可见架构逐段逐项核验 | `r-hO1Nzt` G1 和 `r-iAiCGF` G2 的原错项按真实位置退回。同节其他条目、缺项和旧回执均不能清掉错项 | 两份修正稿通过。真实宿主入口要求首审与独立复核各提交本角色的逐项记录。 [冻结回放](observations-0.7.29-frozen-prose.json) |
| 签名副本回退 | `r-J3dUWi` G2 只删生产冻结分支，恢复两项生产操作的检查失败，合计 2/4 | 加上授权映射后 4/4，保留两项 staging 现行行为。内联与编号提议均验证，签名原件摘要一致。 [签名副本回放](observations-0.7.29-frozen-rollback.json) · [Windows 到 WSL 传输](observations-0.7.29-host-rehearsal.json) |
| 公开诊断 | 公开合成例重现历史 `rollback-order` 的错误顺序 | 正确次序及其他领域的对照保留。宿主以签名失败编号选已登记示例，验证当前版复现回执，原执行会话完成补正。 [公开正反对照](observations-0.7.29-owner-regressions.json) |

逐项审核强制记录事实定位、来源和当前稿件位置，开放式叙述仍由两位审核者独立判断。回退实证只覆盖维护者登记的回退后行为。旧策略继续使用原验收入口。

## 隔离 DSH 和 DeepSeek Flash

初始精确包在 Windows DSH 完成零模型调用预跑，发布工程短题基线 8/8、G3/G4 基线 21/21、仓库预留题基线 18/18。保留正式配置指纹及进程退出验证。 [短题与长题预跑](observations-0.7.29-preflight.json) · [预留题预跑](observations-0.7.29-reservation-preflight.json)
