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
