# 0.7.29 · R73 架构核验、回退演练及诊断

上级为[实验索引](README.md)。沿用 [0.7.28 冻结原稿及短提示](results-0.7.28.md)。本轮使用隔离的 Windows DSH、现有受信签名工具和 WSL 隔离运行器，正式 DSH 放行取决于真实模型短关及后续盲测。

## 冻结稿和宿主回归

| 检查 | 错例 | 正例及验收 |
|---|---|---|
| 可见架构逐段逐项核验 | `r-hO1Nzt` G1 和 `r-iAiCGF` G2 的原错项按真实位置退回。同节其他条目、缺项和旧回执均不能清掉错项 | 两份修正稿通过。真实宿主入口要求首审与独立复核各提交本角色的逐项记录。 [冻结回放](observations-0.7.29-frozen-prose.json) |
| 签名副本回退 | `r-J3dUWi` G2 只删生产冻结分支后 2/4。`r-hO1Nzt` G2 单独抽出解冻步骤时 3/4，生产误受 staging 配额限制 | 两轮分别补齐授权映射、将配额限定到 staging 后均 4/4。内联和编号提议均可演练，原件摘要一致。`r-hO1Nzt` 验证的是选择性回退，原文另有更广的前置步骤。 [最终包冻结回放](observations-0.7.29-frozen-rollback.json) · [试跑轮冻结回放](observations-0.7.29-frozen-pilot-rollback.json) |
| 公开诊断 | 公开合成例重现历史 `rollback-order` 的错误顺序 | 正确次序及其他领域的对照保留。宿主以签名失败编号选已登记示例，验证当前版复现回执，原执行会话完成补正。 [公开正反对照](observations-0.7.29-owner-regressions.json) |

逐项审核强制记录事实定位、来源和当前稿件位置，开放式叙述仍由两位审核者独立判断。回退实证只覆盖维护者登记的回退后行为。旧策略继续使用原验收入口。

## 隔离 DSH 和 DeepSeek Flash

各精确包在 Windows DSH 完成零模型调用预跑，发布工程短题基线 8/8、G3/G4 基线 21/21、仓库预留题基线 18/18。`48e0cc57` 还在真实 Windows→WSL 运行器上复验签名副本回退，负例 2/4、正例 4/4。保留正式配置指纹及进程退出验证。 [短题与长题预跑](observations-0.7.29-guarded-preflight.json) · [预留题预跑](observations-0.7.29-guarded-reservation-preflight.json) · [签名副本运行](observations-0.7.29-guarded-host-rehearsal.json)

### 首次付费短题的实际失误

- `r-zA6W9m` G1 的首审认可第 17 行。理由复述了源码里的正确归属，原句却把业务判定放在入口。独立审核退回该行，总控修正后通过两道核验。`r-MqopHI` G1 两道审核均漏掉另一个明确错误，将源码中由策略模块实施的字段校验归给日志模块。两个可唯一定位的错项加入送审前检查。 [两轮实际审核回执](observations-0.7.29-first-paid-review-negatives.json) · [原样字段枚举回放](observations-0.7.29-grouped-owner-replay.json)
- `r-MqopHI` G2 签名功能 21/21，回退提议提交 11 次均遇到工具公开的 `note` 字段被处理函数拒绝。修正工具字段并加入正例回归，保留精确文件、局部替换与只读权限约束。 [参数结构记录](observations-0.7.29-first-paid-proposal-shape.json)
