# 文件授权与阶段推进

项目维护者在会话工作区根创建 `BUILDING-LOOP.json`。清单逐个列出相对于该根的文件。模式自身的工具不能改授权清单。旧工作区可先补授权文件，再从新会话签发工作单元。授权缺失、无效或在执行中变化时，受控工具拒绝受影响的动作。

```json
{
  "spec": "building-loop/1",
  "instructions": ["AGENTS.md", "DISPATCH.md"],
  "ledgerContext": ["PROJECT.md"],
  "ledgerDocument": "ledger.md",
  "goalContext": ["PROJECT.md"],
  "coordinator": {
    "read": ["AGENTS.md", "DISPATCH.md", "PROJECT.md", "ledger.md", "records/first.json", "records/final.json"],
    "write": ["ledger.md"]
  },
  "units": {
    "K01": {
      "candidate": "module/candidate.md",
      "claims": ["C1", "C2"],
      "continuation": "reuse",
      "calculations": {
        "C2": {
          "kind": "percent-decrease",
          "source": "module/timing.csv",
          "keyColumn": "phase",
          "valueColumn": "mean_ms",
          "before": "before",
          "after": "after",
          "decimals": 2
        }
      },
      "phases": {
        "intake": {
          "read": ["module/INDEX.md", "module/candidate.md"]
        },
        "first-review": {
          "read": ["module/candidate.md", "module/functional.csv"],
          "evidence": ["module/functional.csv"],
          "receipt": "records/first.json"
        },
        "supplement": {
          "read": ["records/first.json", "records/final.json", "module/candidate.md", "module/timing.csv"],
          "write": ["module/candidate.md"]
        },
        "final-review": {
          "read": ["module/candidate.md", "module/functional.csv", "module/timing.csv"],
          "evidence": ["module/functional.csv", "module/timing.csv"],
          "receipt": "records/final.json"
        }
      }
    }
  }
}
```

- `instructions` 可省略。最多三份，并列在总控只读授权里。它们作为项目规则注入，权限仍以清单的精确路径为准。
- `coordinator` 声明总控的准确读写路径。各阶段的 `read`、`write` 单独声明，省略即空。候选要在该阶段的读名单里。原始证据、项目规则和核验回执保持只读授权，核验回执由宿主写入。
- `claims` 指定最低必验编号。候选新增的 `C数字` 编号也要逐条核验。候选用形如 `- C1：断言（出处：module/source.csv 第 2 行）。` 的编号行。核验方提供实际读过的原文起止行，缺项或缺来源退回。带上表头等上下文时，也须完整读取并核到候选所引行。0.6.0 另外强制覆盖整篇正文；`unlisted=[]` 不再代表全文已核。
- `calculations` 可选。`percent-decrease` 从普通 UTF-8 CSV 中两行十进制数复算相对降幅，基准为正；支持含 `×100%` 的换算式，引用同时覆盖两条原始行，例如 `第 2-3 行`。`source-number` 检查指定原文行的数值直接转述，例如 `{"kind":"source-number","source":"sources/moon-facts.md","line":6,"sourceUnit":"Earth days","units":["地球日","天"]}`：原文含唯一数值和单位，当前事实行必须使用等值数字、允许的单位并引用该行。旧错数、额外精度和换算不要混进这条直接转述；其他计算须另行定义规则。补查预检、提交和事实验收均从原文重算，即使另一条断言已失败也不跳过。
- `source-number.scope` 默认 `claim`。明确规定全文中这些单位都描述同一个量时，可配置 `document`：说明段、标题等位置的阿拉伯数字与登记单位也要等值，且不得添加“超过”“比 27 天略长”等上下界或长短比较。它不是自然语言通用事实检测器，不自动识别汉字数词、隐含指代、其他单位或未经声明的换算；多种不同的量不能混用这条全文契约。全文退回保存文档指纹，删除说明段里的错误后允许保留原本正确的编号行；无关修改仍不能绕过重新核数。
- 全文直接转述同一行里的额外操作数或结果也会退回，不能夹入尚未登记的 `27 × 24 = 648 小时` 再声称脚本已经验证。数值相等也不授权升级为“精确值”；相邻精度标签须删除或改用单独有依据的数值契约。保留“原文给出 27 天，未说明更细精度”即可。这是有限的字面检查，不能替代语义核验。
- `sourcePins` 可选，按原文路径登记 `sha256`、`kind` 和 `locator`。单元设置 `requireSourcePins: true` 后要求原始证据都有登记。具体来源口径见[资料核验](verification.md)。
- `goalContext` 声明最多三份中央目标文件，并明确授予各工作角色只读权限。默认沿用 `ledgerContext`，派单前须至少有一份。目标不能是候选、原始证据、回执或模块可写文件。当前目标在每步规则中强制注入，优先于旧派单；每份应保持在 12 KiB 内。补查提交和核验还须实际读过当前目标，回执绑定目标摘要及 `goalFit` 判断。
- `ledgerContext` 声明每轮账本复盘的现状文件；总控也须重读目标和当前通过回执。目标或候选改变后旧回执不能关单，`status.next` 指向重新验收，`advance` 续用独立核验会话。
- `ledgerDocument` 可选，声明用户可读账本的准确相对路径；它须在总控写授权中，并且不能与目标、规则、正文、来源或回执重合。配置后由宿主从当前真实账项导出，模型不能另行覆盖；复盘写出成功后才能报告关单。未配置的旧项目保留宿主状态账本，不能把模型自行编写的文字表视为已验证的完整导出。
- 单元的 `covers` 可列出由本轮成品替代的账目编号，例如 `["extra-faq"]`。关系由项目维护者声明；当前目标下产物通过后，这些账目须登记 `covered` 和 `coveredBy`，或引用目标说明旧事项已 `obsolete`。未登记的关系仍须总控依据现状判断。
- 续派默认 `reuse`。需要新执行会话时由维护者配置 `fresh`，核验会话继续沿用。正在运行的工作单元绑定原总控，失败退回或解阻时保持单元身份。
- `plainLast` 默认 `true`，正文最后实质段须为“大白话”或“直白说明”；非正文产物由维护者显式配置 `false`。此检查在预检、验收和账本关闭时执行。
- `cacheReadRotationThreshold` 可选，为正整数，默认关闭。只按执行子会话实际缓存读取量累计；达到阈值后，在已交付且下次补查的安全边界新开执行会话，同一单元与文件授权不变。被阻塞的未完成阶段仍原会话恢复。它不是上下文窗口大小，也不是项目总 Token 预算；当前没有经过跨话题验证的通用最优值，见[成本与滚动交接](efficiency.md)。

## 工具与状态

`building_loop prepare` 提供当前阶段实际可见的材料、行号、未读页、覆盖入口和参数提示，只登记实际返回的行。同会话同阶段中断后，当前版本未变的读取记录保留。角色可见工具减少错误入口，执行时的白名单与 guard 继续独立检查。

`building_loop_coverage` 提供 `inventory`、`record`、`status`。所有非空白字符由宿主定位到块，核验与独立反证角色逐块提交连续原文、分类、证据及推导。遗漏块、遗漏后半句、伪造引句、形式规则不成立都会拒绝；细节见[全文覆盖与逐条推导](full-coverage.md)。总控不能通过该工具读正文。

覆盖 `status` 默认返回简短摘要，指定 `block` 才取单块详情。`record` 保存本批合法项，错误项列在 `invalid`；`invalidated` 表示因来源变化被撤销的旧证明。清完所有 pending 才能验收。子会话交付并成功通知总控后由宿主结束本轮；通知失败不冒充正常完成。

首审或终审暂通过后进入 `first-audit-ready` 或 `final-audit-ready`，总控 `advance` 派给不同于执行和核验方的独立反证会话。其权限从对应 review 阶段派生，去掉所有核验回执，只有只读材料；旧授权清单无需增加阶段键。它重新核全文后调用 `audit`，通过才进入账本复盘。两位核验者的分类分歧先回核验会话，避免直接制造正文返工。候选、目标或证据变化后重新核验。旧版没有完整覆盖和独立反证的接受回执不能直接关单。

核验及反证的任务说明由宿主按当前目标、单元和阶段生成，不将总控自由填写的 note、前审通过信息或预判答案传入。具体要求先维护到授权的中央文件，再由核验方读取。阶段本身仍有先后门槛，不把这种信息隔离描述成实验意义上的完全双盲。

`building_loop_file` 提供 `list`、`read`、字面 `search`、`write` 和 `history`。搜索只打开白名单中的文本文件。写入需要理由，成功后自动维护 `.building-loop/changes/` 的逐文件日志和 `.building-loop/latest_backup/` 的固定改前版本。原生读写、递归枚举、搜索、终端、直接派发及其他未经授权的工具入口在此预设中拒绝。

`building_loop` 的 `status` 读取宿主台账，`advance` 由总控签发当前阶段。`preflight` 比较整条断言，只剥离已识别的引用位置，引用标签之后的事实仍参加比较。原稿未改且未补证据、纯排版变化和数字复算不符都会拦住。旧版截断的退回摘要交独立核验重建，不能以已经改过的稿件冒充原退回稿。质量退回须落到正文，不能只重写提交说明。

退回事实改完后，还须在该断言行引用本补查阶段实际读过的授权证据及原文行号。只把出处放在文末表格，或用项目规则代替事实证据，会在补查提交前被拒绝；这与终审的逐断言引用契约一致。

补查提交带 `quality` 六项说明。核验方 `assess` 还提交 `goalFit: {pass, basis}`，说明现稿是否满足当前目标。事实 `unsupported` 必须有 `finding: {kind, quote, fix}`：`kind` 为 `missing-evidence`、`contradiction` 或 `scope`，`quote` 必须真实存在于候选，`fix` 是最小修正；矛盾判定还须提供实际读取的反证 file/start/end。可选解释、精度和排版建议不能作为事实缺源。

质量退回通过 `revise`，每项同时有 `revisions: [{field, change, requirement: {file,start,end}}]` 引用当前目标或规则的实际已读行；可选改进放 `suggestions`，不会阻止验收。`sourceRefs`、`unverifiedSources`、`unlisted` 和六项质量检查保持独立。结构检查能拒绝类别不符、未读引用和不存在的原句，语义真假与改进是否必要仍需核验方判断。

核验规则和上下文每步列出当前 `evidence` 白名单；原稿、未核来稿和项目规则不能混入 `sourceRefs`。`unlisted` 仅登记尚未编号的实际待核事实，宿主拒绝空行和重复的编号断言。旧回执若误把空行列为事实，预检跳过该无内容项，仍核其余事实。标题中的真正事实继续核验。

`unlisted` 还要与本轮全文证明中的具体未解决事实范围一致。已经核成非事实的标题、明确假设或展示错误，不能又通过质量元数据变成作者的缺源债；冲突留在核验方纠正参数。真实有事实主张的标题仍逐项核，不能因它是标题而豁免。

核验方漏项、选错证据文件或选错候选引用位置时，宿主拒绝该次核验调用，保留核验阶段，由核验方纠正参数。这类调用问题不自动变成候选事实退回。真正缺源或原文不支持时仍须 `unsupported` 和有原句依据的 `finding`；明确的脚本复算失败仍能直接阻止通过。

事实验收通过后进入 `ledger-review`。总控用 `building_loop_ledger` 读取账本与最新项目现状，给全部未结任务显式处置。完成、被覆盖或失效须有当前原文依据。复核成功后单元进入 `closed`，操作方法见[任务账本](verification.md)。

账本 `review` 的逐项 `basis` 和所需证据不可省略。总说明 `note` 可省略，宿主会从已通过校验的逐项决定生成处置数量摘要，并标记 `contextOrigin=host-from-validated-decisions`；它不替代或虚构任何单项判断。

`block` 记录障碍与恢复条件。子会话在交付前报错或截断时，宿主也会保留阻塞状态。原总控确认后，用 `advance` 在原子会话恢复原阶段。普通通道的子会话消息不能发放阶段权限。

子会话正常结束但未提交本阶段回执，也会登记为可恢复的 `blocked`，沿原阶段、原会话续做。已经提交的阶段不受结束事件影响。事实矛盾的反证参数 `file/start/end` 与 `id/status` 同级；参数放错层级时明确提示修正位置，不误报成资料没读或候选有错。

子会话的预检、提交和质量／事实核验若省略 `unit`，宿主使用该身份唯一绑定的已授权单元。显式传错编号仍拒绝；总控 `advance` 仍须指定单元，总控也不能通过省略编号冒充执行方或核验方。缺少冗余参数不再被误报成角色登记失败。

宿主在为模型组装请求时，从当前台账绑定角色、阶段、工具规则及白名单。阶段切换后先写授权再唤醒目标子会话。一个工作区同时执行一个单元，中断单元保留在账本里。运行状态与任务账本由 DSH 数据目录的 `building-loop-state/` 同文件持久化。项目可另有进度和交接文件。

本模式处理经 DSH 工具发起的文件操作和任务推进。宿主插件和用户自己的终端仍由各自权限管理。需要运行命令的验收项由获授权的运行者执行，并将原始结果作为证据提供给核验方。
