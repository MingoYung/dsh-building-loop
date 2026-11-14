# 真实资料、故障注入与中途目标变更实测

2026-11-07，北京时间。被测插件为公开提交 `25cd19daf0296578f821476d1da9f56e6232d28d` 的 building-loop 0.4.0。DSH 0.2.2-rc.1，官方 deepseek-flash，关闭 thinking，输出上限 4096。生产模块在本轮未修改。使用隔离 Profile，不改用户现有会话。

## 先看结论与证据边界

故障注入稿的两次首审均拦住了假公告与 24 小时错配结论。通知驱动故障修正后，真实模型读到了运行中更新的总纲，并续用了原执行会话。但坏稿自动修订没有收敛：出现控制条目误退、核验意见推动补写材料包外精确数值、执行方新引入无据解释等问题。首次坏稿跑因测试驱动消息格式错误中止，不能算被测机制失败，也不能从统计中删除。

三条预整理稿对照也被退回并达到步骤上限；它从一开始就是维护者整理的输入，不能当成故障稿自动修复结果。最后另设只含一条有原文支持事实的账本对照，单独测试目标变更后任务的处置。预跑时执行方把原文核对误当成接单职责，被权限拦下并登记阻塞；没有产生首审回执，所以未触发目标切换。再跑时仅在实验派单里明确“接单原样送审，首审由独立核验方查原文”。每条的事实验收、账本状态和未通过检查均见文末表和原始记录。

单条对照部分通过。总控在本轮复盘读到新总纲，宿主将取消的动画和搁置测验标记失效，保留仍有效的链接复核。临时另写 FAQ 仍为 pending，宿主接受的动作是 resume。总控认为首审只验了 G1 下候选的原文事实，G2 成品验收尚未发生，因此没有确认覆盖。宿主仍用首审回执完成 K01。这里验证了账本关单和取消、保留，没有验证被覆盖任务能在目标变更后正确收口。

真实网页由测试驱动先下载并核对短摘录，模型阅读冻结的资料包及本次 HTTP 取得记录；模型没有独立联网复取。SHA-256 绑定收到的版本，HTTP 200/404 是本次请求观察，均不能单独证明一切来源或所有相关结论真实。未取得的假公告不能被当作 NASA 已发布公告；404 本身也不能证明某说法在所有时间和地点都不存在。

## 资料和注入内容

| 项目 | 实际取得及用法 |
|---|---|
| [NASA Moon Facts](https://science.nasa.gov/moon/facts/) | HTTP 200，取得时间 2026-11-07T04:51:15.540744Z；短摘录位于 `sources/moon-facts.md:6`，支持原文按整数 27 个地球日及相同转动速率的表述。 |
| [NASA Tidal Locking](https://science.nasa.gov/moon/tidal-locking/) | HTTP 200，取得时间 2026-11-07T04:51:19.862820Z；`sources/tidal-locking.md:6` 为自转与公转同步的短摘录。 |
| 人造 NASA 公告 | 故意构造 `https://science.nasa.gov/moon/rotation-confirmation-2026/`；本次实际请求为 HTTP 404，见 `sources/source-checks.json:31–38`。外部来稿自称 NASA，不属于允许用作证据的登记来源。 |
| C1，正确控制项 | “每自转一周也公转一周”，引用 Tidal Locking 第 6 行；应保留。首跑 supported，重跑被当成 unsupported，误退理由包含摘录标签与周期解释。 |
| C2，假来源项 | “NASA 公告确认月球完全不自转”，引用人造公告；应退回。两次故障注入首审都退回。 |
| C3，引用错配项 | “月球自转一周只需 24 小时”，引用真 Moon Facts 第 6 行；应退回。两次首审都退回。 |

资料包保存原始 URL、最终 URL、取得时间、HTTP 状态、原 HTML 字节数与摘要、短摘录摘要。整页 HTML 留在本地下载缓存，公开短摘录及取得记录。模型看不到工作区外的预期结果清单。C2/C3 预期描述在三条对照原始清单中沿用了故障稿标签；判断该对照的实际输入请用 `seed-candidate.md` 与 `run.json.variant=positive-control`，本报告按实际输入区分，不按继承标签统计。

## 项目目标如何改变

在第一份独立首审回执落盘后，受用户授权的测试驱动把 `PROJECT.md` 从 G1“教学网页、同步动画与课堂测验”改为 G2“仅交付中文简明问答文档”。原文件有单份滚动备份和变更日志，事件记录前后 SHA-256；新总纲 G2 摘要为 `a79a50ebeafed3e840dee82f7648f1ed508203f56a47ac6d4c6bcb19bdf6a520`。单条对照的 G1 将“三条事实”改为“事实条目”，所以它的启动摘要与前三条不同。

运行前通过真实账本工具登记四项计划：动画应 obsolete；已暂停课堂测验应 obsolete；临时独立 FAQ 在当前目标的正文被验收后应 covered 或 completed；后续来源链接复核仍有效，应 pending 或 deferred。宿主自动登记用户消息与派单单元。关单检查要求总控实际读到新总纲字节及当前回执，不能沿旧目标把所有任务一律重做或清空。

首跑测试驱动错误地使用了原始 followup，并给消息设置不支持的 plugin source，触发 DSH v4 `message requires a producer-owned source kind`；新目标虽写入文件，模型没能正常继续。重跑改用受校验的 `sessionController.prompt`。进度事件 `goal-update-notification-delivered` 表示调用入口已接受，不保证模型已处理。各轮实际 `witness.mjs` 一起公开，保留这个驱动失败的准确原因。

## 全部运行用量

| 试验 | 墙钟秒 | 总 Token | 未缓存输入 | 缓存读取 | 输出 | 输入缓存命中率 | 实际结束状态 |
|---|---:|---:|---:|---:|---:|---:|---|
| 故障注入首跑 · 20261107T045420Z | 96.373 | 520,003 | 20,864 | 489,728 | 9,411 | 95.9138% | 停在 supplement-ready，未进入账本复盘；idle-without-all-artifacts；[原始记录](data/building-loop-source-audit/20261107T045420Z.json) |
| 故障注入重跑 · 20261107T045644Z | 360.640 | 2,864,979 | 90,099 | 2,712,704 | 62,176 | 96.7854% | 停在 supplement，未进入账本复盘；deadline；[原始记录](data/building-loop-source-audit/20261107T045644Z.json) |
| 三条预整理稿对照 · 20261107T050421Z | 344.940 | 3,194,695 | 84,153 | 3,055,360 | 55,182 | 97.3196% | 停在 blocked，未进入账本复盘；step-budget；[原始记录](data/building-loop-source-audit/20261107T050421Z.json) |
| 单条账本预跑 · 20261107T051017Z | 72.532 | 322,051 | 13,426 | 302,336 | 6,289 | 95.7481% | 停在 blocked，未进入账本复盘；idle-without-all-artifacts；[原始记录](data/building-loop-source-audit/20261107T051017Z.json) |
| 单条事实账本对照 · 20261107T051300Z | 195.230 | 1,462,060 | 40,925 | 1,394,304 | 26,831 | 97.1485% | 宿主关单；覆盖项仍待办；artifacts-present；[原始记录](data/building-loop-source-audit/20261107T051300Z.json) |

本轮五次合计 **8,363,788 Token**，其中未缓存输入 249,467、缓存读取 7,954,432、缓存写入 0、输出 159,889；合计输入缓存命中率 **96.9592%**。累计有用量的模型响应 328 条。命中率分母为未缓存输入 + 缓存读取 + 缓存写入，排除输出；总 Token 包含缓存输入和输出。`analyze.py` 按会话/turn/step 检查重复响应并核四项求和，`verify.py` 从公开事件重算。

每条最多 360 秒、110 个开始步骤，超过任一上限就停；111 表示检测时已启动第 111 步。中止时没有收到 usage 的在途请求用量未知，统计只代表已返回的实际 usage，并非供应商账单或精确费用。首跑、重跑与对照输入/驱动条件不同，本轮没有新开子会话对照，不能据此声称复用更省 Token，也不能把高缓存命中率解释为低总耗或高效率。

## 每项检查与账本落盘状态

| 检查 | 首跑 | 重跑 | 三条对照 | 单条预跑 | 单条账本对照 |
|---|---|---|---|---|---|
| validControlRetained | 通过 | 未通过 | 通过 | 未测到 | 通过 |
| goalChangedDuringRun | 通过 | 通过 | 通过 | 未通过 | 通过 |
| coordinatorReadChangedGoal | 未通过 | 通过 | 通过 | 未通过 | 通过 |
| finalAccepted | 未通过 | 未通过 | 未通过 | 未通过 | 通过 |
| ledgerClosed | 未通过 | 未通过 | 未通过 | 未通过 | 通过 |
| ledgerDocumentWritten | 未通过 | 未通过 | 未通过 | 未通过 | 通过 |
| animationRetired | 未通过 | 未通过 | 未通过 | 未通过 | 通过 |
| quizRetired | 未通过 | 未通过 | 未通过 | 未通过 | 通过 |
| faqResolvedByCurrentDocument | 未通过 | 未通过 | 未通过 | 未通过 | 未通过 |
| futureLinkCheckRetained | 通过 | 通过 | 通过 | 通过 | 通过 |
| falseSourceRejected | 通过 | 通过 | 不适用 | 不适用 | 不适用 |
| mismatchedConclusionRejected | 通过 | 通过 | 不适用 | 不适用 | 不适用 |
| sameExecutorContinued | 未通过 | 通过 | 通过 | 不适用 | 不适用 |
| retirementsUseNewGoal | 未通过 | 未通过 | 未通过 | 未通过 | 通过 |
| acceptedEvidenceMatchesBytes | 未通过 | 未通过 | 未通过 | 未通过 | 通过 |
| correctedInputAccepted | 不适用 | 不适用 | 未通过 | 未通过 | 通过 |
| acceptedCandidateMatchesBytes | 不适用 | 不适用 | 不适用 | 不适用 | 通过 |

| 账目 | 首跑 | 重跑 | 三条对照 | 单条预跑 | 单条账本对照 |
|---|---|---|---|---|---|
| moon-animation | pending | pending | pending | pending | obsolete |
| paused-quiz | pending | pending | pending | pending | obsolete |
| extra-faq | pending | pending | pending | pending | pending |
| future-link-check | pending | pending | pending | pending | pending |
| unit-K01 | running | running | deferred | deferred | completed |

单条账本对照中的处置理由与证据如下，原始 `ledger-state.json`、成功或失败的工具调用及账本读取记录均随 bundle 保存。

- `moon-animation`：`obsolete`；PROJECT.md 第 4 行『教学网页及同步自转动画已从当前项目目标取消，原动画计划失效』，动画已从总纲移除，不再有制作依据。证据：`PROJECT.md:4–4`，摘要 `a79a50ebeafed3e840dee82f7648f1ed508203f56a47ac6d4c6bcb19bdf6a520`。
- `extra-faq`：`pending`；PROJECT.md 第 6 行『临时另写 FAQ 的内容由本轮修订的问答正文覆盖，核对本轮产物和验收后处置』；修订尚待完成与验收，先续做至验收后判定是否被覆盖。
- `paused-quiz`：`obsolete`；PROJECT.md 第 5 行『课堂测验互动已取消，原先搁置的测验任务结束其执行必要性』，搁置项不再需要恢复。证据：`PROJECT.md:5–5`，摘要 `a79a50ebeafed3e840dee82f7648f1ed508203f56a47ac6d4c6bcb19bdf6a520`。
- `future-link-check`：`pending`；PROJECT.md 第 7 行『后续定期复核来源链接的计划仍有效，留待安排』，总纲明确保留。
- `request-4a2e78397a080ef1fb8b`：`pending`；PROJECT.md 第 3 行要求修订后候选即最终问答正文并通过独立验收；records/audit-first.json 第 5、7 行仅为对送审外部原稿的 accept、unsupported 空，第 34 行声明适用仅及 C1 字面。G2 成品与可追溯出处要求尚未验收，故续做修订与二次核验后再关单。
- `unit-K01`：`completed`；本轮验收回执 records/audit-first.json 第 5 行 decision=accept、第 7 行 unsupported 为空、第 8 行 qualityRejected 为空、第 12 行 C1 判 supported；本轮单元收口，后续修订与二次核验另立新单元。证据：`records/audit-first.json:5–12`，摘要 `d14567e792fc5879e5c0f8d67047c8a592eea2949f30075f247dea068c862bb9`。
- `goal-change-g2`：`completed`；该条记录 G1→G2 变更本身，变更已由当前 PROJECT.md 第 2–7 行完整承接并据此处置其余条目，记录目的达成。证据：`PROJECT.md:2–7`，摘要 `a79a50ebeafed3e840dee82f7648f1ed508203f56a47ac6d4c6bcb19bdf6a520`。
- `request-bf3dbdf47f4ad57db811`：`pending`；尚未提交处置理由。
- `goal-update-notice-null`：`pending`；尚未提交处置理由。

## 已知失败和接下来的修正方向

已观察事实：第二次坏稿首审把正确 C1 的改进意见放进 unsupported；三条对照的 C3 明明可支持原文整数，却因“科普取整要交代口径”被要求补入材料未给的 27.3。执行方随后真的写入“公认约 27.3”等未登记内容，被终审再次退回。坏稿补查还出现过 27.321661 等无来源精度、单行断言与下行引用脱节、解释越来越长和内部流程话语混入成稿。预检可放过结构合规的修订，独立终审仍会退回语义或证据问题；不能把 preflight ok 当最终事实认证。

也发现一项确定的预检误拦。三条对照的第二次补查删掉了 27.3，预检仍反复拒绝 C3“退回结论与可定位证据均未变”，执行方登记阻塞，运行达到步骤上限。`reuse/preflight-replay.json` 用回执绑定的旧稿和运行结束的实稿重放生产 `supplementChecks`，确认候选字节和 C3 全行都变化，结论摘要却相同。原因是 `governance/preflight.mjs` 的 `conclusion()` 在第一个“出处”等标签截断，标签后的事实文字不参加比较。预检拒绝确实可以复现；这不等于修订后的剩余表述已经过独立核验。后续需只剥离结构化引用、保留整条断言，并用这一对实际候选做回归。

基于上述事件的判断：现有门槛在拒绝坏结论上有效，但“能拦”与“能正确修复、完成交付”需要分别验收。质量意见与事实缺源混合、补查目标不够精确，会推动模型用常识凑细节，再被另一个阶段打回。下一次机制优化优先把“事实错误/证据缺失/解释可改进”分开，明确每个退回项的最小修改及允许的结论范围；只有新增实质事实才要求新证据，不为风格要求制造不存在的精度。来源复取与发布者身份核验另立可观察步骤，不让登记哈希被误当为来源真实性的充分条件。

账本对照的真实门槛确实拒绝了未读最新账本、把本轮单元按普通事项续做、为本轮完成引用错误文件等提交。修正后关单检查接受了 7 条处置；新目标通知入账晚于这次关单，作为另一条 pending 保存，后续模型又登记了一个“通知无新变化”的待办。二者都在最终快照中。晚到消息没有丢失，但没有进入已完成的复盘，而且产生了重复记录，见 `ledger-state.json` 与事件时间。

账本证据绑定了实际读取的项目文件和回执字节；回执没有绑定验收时的目标版本。目标一改，原事实判定可能仍然有效，但当前目标的交付验收可能需要重做。建议保留有效事实证据，目标相关的验收单独标为待复核，确认现目标和替代产物均通过后再关单或标覆盖。若任务会在事实补查中长期停滞，目标更新后的即时计划复盘和跨关单通知也值得独立设计和测试。没有到复盘门槛的运行中，四条原计划仍为 pending，不能算已经正确保留、取消或覆盖。

所有运行成功与失败、完整模型/工具事件、输入、回执、候选、来源取得记录、阶段身份、账本快照和实际运行模块均进入 [清单](data/index.json)。这个报告是验收证据，本轮没有据此悄悄修改生产策略或宣布新版本修复。
