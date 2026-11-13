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
- `r-zA6W9m` G2 签名功能 21/21，回退说明只删 staging 上限常量，副本实跑 1/4。生产仍冻结，staging 配额路径报错。到 420 秒完成窗口仍停在架构同步。两轮短题完整放行 **0/2**。 [综合验收](observations-0.7.29-first-paid-combined.json) · [放行判定](observations-0.7.29-first-paid-exact-gate.json)

同一 DeepSeek Flash，两个重复，各模式使用相同短业务提示。标准加清单组另带固定通用清单。缓存命中以缓存读取除以全部输入计。对齐窗口每阶段 210 秒，完整窗口纳入实际延长和已补记的持久化响应。

| 模式 | 210 秒对齐 Token | 缓存命中 | 完整 Token | 缓存命中 |
|---|---:|---:|---:|---:|
| 标准 | 4,057,804 | 98.1031% | 5,170,118 | 98.4343% |
| 标准＋清单 | 4,444,835 | 98.2177% | 6,340,204 | 98.5533% |
| Building-loop | 5,641,746 | 94.3339% | 11,372,103 | 95.7264% |

三组用量缺记均为 0。标准两轮功能分别为 18/18→21/21、17/18→20/21。标准加清单和 Building-loop 两轮功能均为 18/18→21/21。Building-loop 两轮 G1 关单并从同一目录进 G2，G2 均未通过完整验收。 [脱敏原始记录](observations-0.7.29-first-paid-public.json) · [用量细项](observations-0.7.29-first-paid-measures.json)

### 第二批短题的回退补正和剩余架构问题

- `r-h4cllo` G2 首次回退提议 3/4，漏保留 staging 配额。宿主交回同一执行会话，只读补正提议后 4/4。回执重验原 Ed25519 签名和工件摘要，只在隔离副本改 `policy.py`。独立复核退回正文中扩大回退范围的陈述，修订后仍残留扩大范围的文字。已把登记恢复和保留条款生成为宿主管理的回退小节，保留其他章节的独立审查。 [真实回退补正](observations-0.7.29-guarded-live-rehearsal.json)
- `r-iHOuis` G1 首审把非对象和缺字段两类请求标作同一响应，独立复核退回原行。三种非对象符合预期，四种对象缺字段各返回相应字段错误。`r-h4cllo` G1 则两道审核均漏过了可唯一定位的模块字段归属与 JSON 解码器调用。用冻结稿回放这两类现行源码错误，准确定位 4 处，定点正例 0 处。 [缺字段实际响应](observations-0.7.29-guarded-missing-fields.json) · [字段和解码器正反回放](observations-0.7.29-inline-owner-replay.json)
- 已安装的精确宿主模块走真实签名副本的公开回滚次序复现。坏版本的依赖边用例形成认证行为回执，坏版本无边对照、正版本及过期版本分别检查。 [签名诊断实跑](observations-0.7.29-guarded-host-diagnosis.json)

第二批仍为 **0/2 完整放行**。`r-iHOuis` G1 功能 18/18，终审到达时限，G2 在冻结副本续跑，功能 21/21，独立审核未完成。`r-h4cllo` 同目录交接，G1 18/18、G2 21/21。G2 的宿主最终相位为 `closed`，运行器完成状态仍记 `completion-cap`；独立的源码与正文检查仍发现实质问题。两轮标准和标准加清单各通过 18/18→21/21 功能用例。 [第二批原始记录](observations-0.7.29-guarded-paid-public.json)

| 模式 | 210 秒对齐 Token | 缓存命中 | 完整 Token | 缓存命中 |
|---|---:|---:|---:|---:|
| 标准 | 2,553,862 | 98.1954% | 2,553,862 | 98.1954% |
| 标准＋清单 | 3,168,933 | 97.9299% | 3,975,782 | 98.2412% |
| Building-loop | 6,192,516 | 92.1898% | 19,683,235 | 95.5887% |

第二批三组用量缺记均为 0。 [用量细项](observations-0.7.29-guarded-paid-measures.json)

### 宿主管理回退范围的候选包

`33d62ae0` 版本通过本地 414 项回归和三套 Windows 零模型安装预跑。签名副本演练仍保留 2/4 的旧负例和 4/4 的正例，公开回滚顺序的当前签名正反复现仍使用受信运行器。 [Windows 预跑](observations-0.7.29-locked-preflight.json) · [签名副本](observations-0.7.29-locked-host-rehearsal.json) · [诊断](observations-0.7.29-locked-host-diagnosis.json)

用两个真实冻结稿验证宿主替换错误回退小节。原始签名先逐份核验，源码字节和未涉及正文保留。隔离重放按新授权摘要给原工件和原用例重新签名，真实 Windows 到 WSL 回执各 4/4，伪签名拒绝。`r-h4cllo` 另有一个解码器名错误，宿主先拦住该错项，回放按原位置修正后继续验证回退小节。 [真实冻结稿的安装包正反回放](observations-0.7.29-locked-actual-scope.json)

本包在 `r-A6f7Fu` 真实 DeepSeek 短关触发 `rollback-order`。只读诊断复现登记的公开依赖边反例，总控核实后交回同一执行会话，在 161.220 秒取得 18/18 签名结果。独立重放对比该轮失败快照和修复后签名快照，验证带依赖边的坏例和无边对照。 [真实诊断过程](observations-0.7.29-locked-live-diagnosis.json) · [正反代码复放](observations-0.7.29-locked-live-diagnosis-replay.json)

第三批两轮 G2 都在原执行会话把隔离副本回退从 3/4 补到 4/4，发布的回退小节与登记的恢复和保留条款一致。两次失败都来自第一次提议丢掉 staging 配额。 `r-K7uKAM` G1 宿主在 257.334 秒结单，当前对话仍调用两次工具、产生至少 115,631 个已报告 Token，直到清理时退出，运行记录仍判为到达时限。 [回退补正](observations-0.7.29-locked-live-rehearsal.json) · [关单与时限](observations-0.7.29-locked-closure-terminal.json)

两轮 G1 的实际交付都存在架构错归。`r-K7uKAM` 第 17 行用模块短名将非对象判定归给 `journal`，两份审核理由却写的是正确的 `planner`。`r-A6f7Fu` 归错了多个字段校验位置，且错误解释回滚顺序的注释随正确实现一起获通过。进一步修补已从签名文件中解析唯一模块短名，检查有明确引用的输入条件及返回值，并覆盖未加反引号的字段列表。将回退节重生成之前移除已知会被覆盖的旧断言，仍对其他章节使用同样的检查。另移除未被消费的可选 `note` 专用长度门槛，三次被拒绝的实际说明分别长 546、570、870 UTF-16 代码单元。以上补强经冻结稿和定向回归，第三批真实模型使用的是补强前的精确包。 [短名错稿回放](observations-0.7.29-typed-direct-replay.json) · [字段错稿回放](observations-0.7.29-bare-owner-replay.json) · [参数结构](observations-0.7.29-locked-proposal-shape.json)

第三批三组两轮功能均为 18/18→21/21。`r-A6f7Fu` 在同目录完成 G1、G2 两轮宿主关单，且通过功能、模块边界及行为补验。`r-K7uKAM` G1 到达时限，G2 从冻结副本续跑并关单。两轮完整放行 **0/2**，各阶段都存在架构错项，`r-A6f7Fu` 的必要注释也有实质错误。后续补强的本地回归 **416/416** 通过。 [第三批原始记录](observations-0.7.29-locked-paid-public.json) · [独立放行判断](observations-0.7.29-locked-paid-exact-gate.json) · [独立注释审查](observations-0.7.29-locked-paid-independent-quality.json)

| 模式 | 210 秒对齐 Token | 缓存命中 | 完整 Token | 缓存命中 |
|---|---:|---:|---:|---:|
| 标准 | 2,036,336 | 97.8476% | 2,116,032 | 97.9162% |
| 标准＋清单 | 4,347,537 | 98.3840% | 4,882,814 | 98.4397% |
| Building-loop | 6,888,905 | 92.5478% | 14,992,463 | 94.8340% |

三组用量缺记、无法归属的持久化用量和会话日志读取错误均为 0。Building-loop 完整窗口用量为标准的约 7.09 倍。这组样本中三个模式的功能同分，Building-loop 的独立验收仍查到错误。 [第三批用量细项](observations-0.7.29-locked-paid-measures.json)

## 放行状态

三个精确付费包各做两轮短对照，总计完整放行 0/6。未启动 G3/G4 和仓库新题的付费盲测，两个场景均保留零模型预跑结果。正式 DSH 的 Profile 指纹保持一致，正式版本仍为 0.7.18。ClearAI 三方对照在隔离目录准备了同模型、同底稿和评分口径，仍待完整放行后的实测。
