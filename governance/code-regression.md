# 代码送审前的测试契约

上级为[文件授权与阶段推进](README.md)。适用于所有者确认开工且由 Building-loop 管理的代码单元。按现有项目测试方式运行，维护者决定哪些旧用例必须纳入、哪些新增用例证明本轮需求。插件只核对独立运行者的签名和结果，不替项目选择测试框架或运行 shell 命令。

```json
{
  "sources": ["src/normalize.py"],
  "tests": {
    "file": "receipts/candidate-tests.json",
    "publicKey": "<Ed25519 SPKI Base64 公钥>",
    "previousSuiteSha256": "<旧测试套件 SHA-256>",
    "suiteSha256": "<包含新增用例的测试套件 SHA-256>",
    "requiredCases": ["collapse-spaces"],
    "regression": {
      "baselineFile": "receipts/baseline-tests.json",
      "previousCases": ["lowercase", "preserve-punctuation"]
    }
  }
}
```

把该对象放入 `BUILDING-LOOP.json` 中对应单元的 `codeTask`。授权文件、基线和候选回执不交给模型写，签名私钥只保存在可信测试运行者一侧。测试运行者应把候选文件复制到隔离环境，确认运行前后的摘要一致，再对实际用例结果签字。用例编号在新旧套件之间保持稳定。旧测试中的预期失败、跳过和错误都按实记录。

1. **先记录改前结果。** 在首次派发前，独立运行旧套件。基线回执的 `spec` 是 `building-loop-code-regression-baseline/1`，包含 `unit`、`policySha256`（授权清单原始字节的 SHA-256）、`suiteSha256`（旧套件摘要）、`artifacts`、`cases` 和 `runId`。`artifacts` 按路径排序，登记候选、接单与补查写白名单，以及可选 `regression.inputs` 中的行为依赖文件，每项为 `{path,sha256}`，尚未创建的文件用 `null`。可调用同模块导出的 `codeRegressionArtifacts(root, spec)` 生成列表，`spec` 为宿主解析后的单元授权。每个旧用例以 `{id,status}` 记录，状态为 `passed`、`failed`、`skipped` 或 `error`。宿主在执行方获得写权前核对并锁定当时通过的用例。
2. **按候选实际字节重跑。** 从执行方 `prepare.codeTask.regressionProof` 读取挑战。保留其中绑定字段，从回执中去掉 `file`、`previousCases`、`requiredCases`、`protectedCases`，补上 `runId` 和 `cases`，登记所有旧用例与新增必测项的真实结果。候选摘要不一致、漏报用例、旧通过项失败或跳过、新必测项未通过，都会被拒绝。改完重新读取挑战并测试；旧回执无法替新字节送审。
3. **由可信运行者签名。** 两种回执均调用 `governance/code-intake.mjs` 导出的 `codeRegressionSigningBytes(receipt)`，用 Ed25519 签名并将 Base64 写入 `signature`，再放到配置的回执路径。回执应原子发布，避免宿主读到半份。签名证明谁对这组运行结果负责；运行者还要保证套件来源、执行环境和用例本身可信。

绿地单元没有旧行为时，旧清单用空数组，仍需要基线及新增必测结果。配置须覆盖会影响行为的实现、配置和依赖。缺少可信运行者时，新的受控代码单元应先完成接入，宿主会报告缺少的配置或回执。

## 局部编辑与即时诊断

启用签名回归的代码单元里，执行方修改已有实现文件时，通过 `building_loop_file` 的 `edit` 提交。先 `read` 取得文件当前的 `sha256`，再传 `path`、`beforeSha256`、`oldText`、`newText` 和 `note`。原文片段在当前版本必须唯一。也可以用 `edits` 一次提交同一文件内的多个改动，每段都以同一份原文定位，全部匹配后才落盘。新建已授权文件仍用 `write`。

维护者可以在 `codeTask` 增加 `"diagnostics": {"checkSet": "unit-smoke-v1"}`。其中 `checkSet` 要填运行器已登记的检查组编号。DSH 宿主通过 `DSH_BUILDING_LOOP_DIAGNOSTICS_URL` 指定带端口的 `http://127.0.0.1:端口/路径`，通过 `DSH_BUILDING_LOOP_DIAGNOSTICS_TOKEN` 指定 32–256 位凭证（字母、数字或 `._~-`）。`DSH_BUILDING_LOOP_DIAGNOSTICS_TIMEOUT_MS` 默认为 12000，可设为 500–30000。受信运行器按登记的 `checkSet` 执行固定用例，在隔离目录运行实际收到的文件版本。

- 宿主在每次有效落盘后发起带 Bearer 凭证的 JSON POST。请求包含 `spec`（固定为 `building-loop/diagnostics/1`）、`requestId`、`checkSet`、`unit`、`phase`、`policySha256`、`goalSha256`、`snapshotSha256`、`changed`（`path` 和 `sha256`）及 `artifacts`（每项为 `path`、`sha256`、`contentBase64`）。未创建文件的摘要和内容均为 `null`。宿主最多发送 256 份文件和 4 MiB 原始内容。
- 运行器返回 HTTP 200 和 JSON，回显 `spec`、`requestId`、`snapshotSha256`，并设置 `status` 为 `passed`、`failed` 或 `unavailable`。失败时用 `firstError` 给出第一条真实失败的 `caseId` 和 `message`。可带执行方能读取的工件相对 `path`，带路径时可附 `line`。日志先去除凭证和无关信息。
- 工具把 `diagnostics` 随写入结果送给执行方。配置缺失、超时或结果过期时，返回对应状态，写入结果独立保留。目标、阶段、授权或相关工件改变后，旧反馈作废。送审仍由原有签名回归检查全部旧通过项和新增必测项。

## 执行方受控复现

在诊断配置登记 `"diagnostics": {"checkSet": "unit-smoke-v2", "protocol": 2, "recipes": ["app-cli"]}`。检查组和配方由维护者在受信运行器端登记。版本 2 仍使用上节的宿主地址和凭证。已有版本 1 配置继续使用上节契约。

- 当前接单或补查的执行方可以调用 `building_loop_reproduce`。用 `{"action":"check"}` 重跑当前候选的快检并获取可用配方。用 `{"action":"probe","recipe":"app-cli","args":["input.txt"],"files":[{"path":"input.txt","content":"sample"}]}` 跑一个临时最小用例。也可传 `stdin`。配方参数作为数据传给维护者选定的入口，输入文件只出现在临时目录。
- 自动写后检查和手动复现都绑定当前工件版本。版本 2 请求用 `building-loop/diagnostics/2`，复用版本 1 的单元、授权、目标、摘要和工件字段，额外传 `operation`（`check` 或 `probe`）、`protectedCases`、`requiredCases`。自动检查带 `changed`，手动探针带 `probe`（配方、参数和样例）。探针需要当前执行方可读取整个运行快照。
- `check` 的回复包含 `old` 和 `required`。前者报告旧通过集合的首个失败 `firstError`，后者每个新增必测返回 `{caseId,status,error?}`。旧用例短路后仍须运行各新增必测。只有实际通过才填 `passed`，基础设施异常填 `unavailable`。错误带 `caseId`、`message`，可附源码位置和 `stack` 中的 `{path,line,function?}`。将详细错误限定为可公开的用例和执行方有权读取的候选源码，先清除密钥、私有夹具和绝对路径。
- `probe` 的回复包含 `probe.exitCode`、可选 `stdout`、`stderr`、`stack` 和 `truncated`。运行器将候选工件只读挂载、在独立目录生成样例、清除继承环境、隔离文件和网络并限制耗时与输出。入口与运行时由受信配置固定，按配方检查参数，禁止拼接命令。签名私钥和完整受信用例保存在独立的签名运行器。快检与复现结果只用于修复，送审仍凭当前工件的签名回执。
