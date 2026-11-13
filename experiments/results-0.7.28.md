# 0.7.28 关键职责实证

上级为[实验与验收索引](README.md)，问题追溯到[0.7.27 两轮冻结短题和难题](results-0.7.27.md)。

## 宿主契约

关键职责按业主条款、可运行的公开输入及预期响应、可定位的源码条件和同版实际轨迹核验。业务条件、异常兜底和透传各有证据类型。仍须通过同一签名回归、两道独立核验和账本。总控看到生成的职责位置和响应，不新增源码权限；生成章节之外的架构说明继续由两位核验者对照源码。

## 原失败和正反复放

取 `r-9CyRwq`、`r-v7UYLt` 的原签名源码，按原样验证两处错报归属。相同 `[]` 输入和 `invalid-request` 响应可从真实执行行定位到 planner 的实际拒绝。两个正确归属、两条透传、两条解码兜底通过；未运行的同名异常兜底留待核验。归档中的另两类实现采用三元式或解析后局部变量作判定，本版不把无法确认的语句强行归给 planner。 [固定源码复放](observations-0.7.28-frozen-witness-replay.json) · [八份架构归档](observations-0.7.28-architecture-fixtures.json) · [额外运行对照](observations-0.7.28-historical-owner-traces.json)

## 独立新题

仓库预留和事件回放另起两阶段，用相同模型的标准、标准加清单、Building-loop 三组作对照。基线是单条查询和快照，第一阶段加入原子多事件、时间窗冲突和重试身份，第二阶段更改目标，加入修订号、原子转移、关闭窗和来源记录。隐藏评分在工作区之外；主对照和冻结后新种子独立。压力控制覆盖 24,000 条记录和 4,096 个事件。隔离参考实现通过 H1 60/60、H2 104/104；同输出但把业务判定移到入口的变体仍能功能满分，职责证据明确判错，线性扫描对照未过压力阈值。 [参考和反例校准](observations-0.7.28-reservation-calibration.json)

## Windows DSH 预跑

先冻结 `5a1f0aa8e140f65d4e04f8c79528ad560c491eb1a6c41fe1b2dc6d6b6cb9ea57` 做先导。Windows 无模型预跑短题基线 8/8 加 6 个适配器控制，难题 21/21 加 7 个控制；两个隔离宿主已退出。随后冻结 `ae3152d06ed4740b6da3ba6e89f20fc87bf7d948444071507bc7884bafa3df8a`，加强 Python 名字重绑和输出路径判定，并提示普通章节引用生成职责。 [先导预跑](observations-0.7.28-preflight.json) · [提示与评分器字节](observations-0.7.28-fixture-pins.json) · [原生 trace 正反](observations-0.7.28-owner-trace-controls.json)

最终包短题、原难题和仓库预留新题的 Windows 无模型预跑分别通过 8/8＋6、21/21＋7、18/18＋7。仓库预留新题另用已安装的 54 个运行文件重放三类职责，三条正确输入通过；功能 104/104 的错误归属仍被宿主定位为入口判定与业主要求不符。 [旧题最终包预跑](observations-0.7.28-final-preflight.json) · [新题最终包预跑](observations-0.7.28-reservation-final-preflight.json) · [安装后证据通路回放](observations-0.7.28-reservation-host-replay.json)

本地串行套件 399/399；最终归档后对应架构、代码复核和输入契约定向测试 35/35。

正式 DSH 放行依赖最终冻结包的真实短回归、两组盲测和独立质量证据。正式版本未变，ClearAI 真实对比在放行后执行。
