# 文件授权与阶段推进

项目维护者在会话工作区根创建 `BUILDING-LOOP.json`。清单逐个列出相对于该根的文件。模式自身的工具不能改授权清单。旧工作区可先补授权文件，再从新会话签发工作单元。授权缺失、无效或在执行中变化时，受控工具拒绝受影响的动作。

```json
{
  "spec": "building-loop/1",
  "instructions": ["AGENTS.md", "DISPATCH.md"],
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
- `claims` 指定必须核验的编号。候选用形如 `- C1：断言（出处：module/source.csv 第 2 行）。` 的编号行。宿主从编号定位候选，核验方提供实际读过的原文起止行。缺项或缺来源的结果退回，支持项引用未读或已变的原文须重查。核验可以带上表头等上下文，仍须完整读取并核到候选所引的原文行。原文能否支持断言仍由核验方判断。
- `calculations` 可选。它把登记的断言编号绑定到授权原始数据和内置运算。当前支持 `percent-decrease`，用普通 UTF-8 CSV 中两行十进制数复算相对降幅，基准为正。断言行在出处之前只写本项结果的百分比，含 `×100%` 的推导可另列一行或写入 `quality.method`。引用写明同时覆盖两条原始行的范围，例如 `第 2-3 行`。补查预检、提交和事实验收会从当前原始文件独立复算。
- 续派默认 `reuse`。需要新执行会话时由维护者配置 `fresh`，核验会话继续沿用。正在运行的工作单元绑定原总控，失败退回或解阻时保持单元身份。

## 工具与状态

`building_loop_file` 提供 `list`、`read`、字面 `search`、`write` 和 `history`。搜索只打开白名单中的文本文件。写入需要理由，成功后自动维护 `.building-loop/changes/` 的逐文件日志和 `.building-loop/latest_backup/` 的固定改前版本。原生读写、递归枚举、搜索、终端、直接派发及其他未经授权的工具入口在此预设中拒绝。

`building_loop` 的 `status` 读取宿主台账，`advance` 由总控签发当前可以开始的阶段。`preflight` 返回补查待改项和当前脚本结果。`submit` 由执行方完整读回候选后提交，逐条检查退回的结论或可定位证据是否有实质变化。单改标题、空白或出处格式不构成补查。可复算项与结果不符时停在补查阶段。新版首次续派旧退回单元时，以当时的候选建立补查基线。

补查提交带 `quality`。分别说明资料出处和待证边界、结论优化、方法验证与取舍、备选方案、层次与必要细节、给读者的一句大白话。独立核验方确认事实可支持后，先用 `building_loop_quality` 的 `assess` 给六项各自的依据，在 `revise` 列出需要退回的质量项，再用 `building_loop` 的 `review` 提交逐条事实判断。质量判断绑定当前候选文件的指纹。任一项退回都进入下一轮补查。实际核验的文件、行号和指纹以回执的结构化 `checks` 与读取记录为准。资料的外部真实性、推论和方案优劣需要按实际证据判断。

`block` 记录障碍与恢复条件。子会话在交付前报错或截断时，宿主也会保留阻塞状态。原总控确认后，用 `advance` 在原子会话恢复原阶段。普通通道的子会话消息不能发放阶段权限。

宿主在为模型组装请求时，从当前台账绑定角色、阶段、工具规则及白名单。阶段切换后先写授权再唤醒目标子会话。一个工作区同时推进一个未结单单元。运行台账由 DSH 数据目录的 `building-loop-state/` 持久化。项目可另有自己的进度和交接文件，供总控更新及人阅读。

本模式处理经 DSH 工具发起的文件操作和任务推进。宿主插件和用户自己的终端仍由各自权限管理。需要运行命令的验收项由获授权的运行者执行，并将原始结果作为证据提供给核验方。
