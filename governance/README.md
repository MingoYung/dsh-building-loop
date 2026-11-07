# 文件授权与阶段推进

项目维护者在会话工作区根创建 `BUILDING-LOOP.json`。清单逐个列出相对于该根的文件。模式自身的工具不能改授权清单。旧工作区可先补授权文件，再从新会话签发工作单元。授权缺失、无效或在执行中变化时，受控工具拒绝受影响的动作。

```json
{
  "spec": "building-loop/1",
  "instructions": ["AGENTS.md", "DISPATCH.md"],
  "ledgerContext": ["PROJECT.md"],
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
- `claims` 指定最低必验编号。候选新增的 `C数字` 编号也要逐条核验。候选用形如 `- C1：断言（出处：module/source.csv 第 2 行）。` 的编号行。核验方提供实际读过的原文起止行，缺项或缺来源退回。带上表头等上下文时，也须完整读取并核到候选所引行。未编号待核事实通过 `unlisted` 登记。
- `calculations` 可选。当前支持 `percent-decrease`，从普通 UTF-8 CSV 中两行十进制数复算相对降幅，基准为正。支持含 `×100%` 的常见换算式。引用同时覆盖两条原始行，例如 `第 2-3 行`。补查预检、提交和事实验收都从当前原始文件重算。
- `sourcePins` 可选，按原文路径登记 `sha256`、`kind` 和 `locator`。单元设置 `requireSourcePins: true` 后要求原始证据都有登记。具体来源口径见[资料核验](verification.md)。
- `ledgerContext` 可选，最多三份总控获准读取的项目现状文件，每轮账本复核时读取当前版本。省略时仍需以本轮验收回执完成账本复核。
- 续派默认 `reuse`。需要新执行会话时由维护者配置 `fresh`，核验会话继续沿用。正在运行的工作单元绑定原总控，失败退回或解阻时保持单元身份。

## 工具与状态

`building_loop_file` 提供 `list`、`read`、字面 `search`、`write` 和 `history`。搜索只打开白名单中的文本文件。写入需要理由，成功后自动维护 `.building-loop/changes/` 的逐文件日志和 `.building-loop/latest_backup/` 的固定改前版本。原生读写、递归枚举、搜索、终端、直接派发及其他未经授权的工具入口在此预设中拒绝。

`building_loop` 的 `status` 读取宿主台账，`advance` 由总控签发当前可以开始的阶段。`preflight` 返回补查待改项和当前脚本结果。`submit` 由执行方完整读回候选后提交，逐条检查退回的结论或可定位证据是否有实质变化。单改标题、空白或出处格式不构成补查。可复算项与结果不符时停在补查阶段。新版首次续派旧退回单元时，以当时的候选建立补查基线。

补查提交带 `quality` 六项说明。独立核验方先用 `building_loop_quality` 的 `assess` 给独立依据，同时交 `sourceRefs` 原文引用、`unverifiedSources` 待核资料、`unlisted` 未编号事实和 `revise` 质量退回项。来源叙述涉及本轮未读文件时会被拒绝。再用 `review` 提交逐条事实，质量判断和原文版本重新核对。宿主生成实际读取清单和原文摘要，任一项退回都进入补查。

事实验收通过后进入 `ledger-review`。总控用 `building_loop_ledger` 读取账本与最新项目现状，给全部未结任务显式处置。完成、被覆盖或失效须有当前原文依据。复核成功后单元进入 `closed`，操作方法见[任务账本](verification.md)。

`block` 记录障碍与恢复条件。子会话在交付前报错或截断时，宿主也会保留阻塞状态。原总控确认后，用 `advance` 在原子会话恢复原阶段。普通通道的子会话消息不能发放阶段权限。

宿主在为模型组装请求时，从当前台账绑定角色、阶段、工具规则及白名单。阶段切换后先写授权再唤醒目标子会话。一个工作区同时执行一个单元，中断单元保留在账本里。运行状态与任务账本由 DSH 数据目录的 `building-loop-state/` 同文件持久化。项目可另有进度和交接文件。

本模式处理经 DSH 工具发起的文件操作和任务推进。宿主插件和用户自己的终端仍由各自权限管理。需要运行命令的验收项由获授权的运行者执行，并将原始结果作为证据提供给核验方。
