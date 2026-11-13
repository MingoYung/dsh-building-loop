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

维护者可在同一配置的 `recipeInputs` 按已批准配方登记输入形状。例如 `{"compile-python":{"args":{"min":1,"types":["source"]},"stdin":"forbidden","files":{"min":0,"max":0}}}` 要求一个当前快照中存在且本角色获读授权的已登记源码路径，省略 stdin 和样例文件。普通 argv 项为 `text`，`types` 的长度是最大参数数，`stdin` 可设为 `forbidden`、`optional` 或 `required`。需要构造非法 JSON 的 CLI 配方仍接受文本，实际数据错误由程序输出验证。

执行方可在 `prepare` 或 `check` 读取授权形状，独立审核只看其核验配方的形状。形状不符时，宿主在请求运行器前返回 `invalid-input`、字段及修正说明。版本 2 适配器亦可对探针返回同一回执信封及 `{"status":"invalid-input","inputError":"args"}`，字段允许 `args`、`stdin` 或 `files`。适配器保留权限、运行器及传输错误的独立报告，并继续核验它接到的输入。已有配方可继续采用原有未声明形状的调用方式。

- 当前接单或补查的执行方可以调用 `building_loop_reproduce`。用 `{"action":"check"}` 重跑当前候选的快检并获取可用配方。用 `{"action":"probe","recipe":"app-cli","args":["input.txt"],"files":[{"path":"input.txt","content":"sample"}]}` 跑一个临时最小用例。也可传 `stdin`。配方参数作为数据传给维护者选定的入口，输入文件只出现在临时目录。
- 自动写后检查和手动复现都绑定当前工件版本。版本 2 请求用 `building-loop/diagnostics/2`，复用版本 1 的单元、授权、目标、摘要和工件字段，额外传 `operation`（`check` 或 `probe`）、`protectedCases`、`requiredCases`。自动检查带 `changed`，手动探针带 `probe`（配方、参数和样例）。探针需要当前执行方可读取整个运行快照。
- `check` 的回复包含 `old` 和 `required`。前者报告旧通过集合的首个失败 `firstError`，后者每个新增必测返回 `{caseId,status,error?}`。旧用例短路后仍须运行各新增必测。只有实际通过才填 `passed`，基础设施异常填 `unavailable`。错误带 `caseId`、`message`，可附源码位置和 `stack` 中的 `{path,line,function?}`。将详细错误限定为可公开的用例和执行方有权读取的候选源码，先清除密钥、私有夹具和绝对路径。
- `probe` 的回复包含 `probe.exitCode`、可选 `stdout`、`stderr`、`stack` 和 `truncated`。运行器将候选工件只读挂载、在独立目录生成样例、清除继承环境、隔离文件和网络并限制耗时与输出。入口与运行时由受信配置固定，按配方检查参数，禁止拼接命令。签名私钥和完整受信用例保存在独立的签名运行器。快检与复现结果只用于修复，送审仍凭当前工件的签名回执。

## 执行停滞的分层诊断

版本 2 受控复现按源码及登记工件的当前摘要、目标、阶段和执行身份分开计数。三个独立调用重复出现同类错误，或者完整检查仍失败且同版又执行四次小探针时，宿主暂停执行。第二种情况须先有落盘后失败的检查，或两次明确失败的完整检查。源码推进或完整检查通过后，旧计数不会继续触发。

1. 总控用 `building_loop_diagnose triage` 明确判断参数、运行器、语法或行为层。宿主冻结原执行方权限，收到分层后才允许 `advance`。需要诊断复现的工件与配方必须在原授权内。
2. 独立只读诊断会话用 `prepare` 取目标、授权和配方。语法证据来自 `building_loop_reproduce` 的已登记编译配方，区分报错行与原因行。行为用 `building_loop_diagnosis_probe`，引用已读的现行条款并比较一个可观察结果。参数与运行器问题使用类型化宿主回执。
3. `submit` 绑定实际已读的当前源码行、复现回执、具体原因和定点修法。总控用 `verify` 核对版本、定位和复现，确认后宿主唤醒原执行会话。总控仍使用原文件白名单。原执行方在 `prepare` 读取核实结论和可重跑输入。
4. 如果实测指向另一层，诊断会话用 `reroute` 把证据送回总控重新分层。诊断中断时可续回同一只读子会话。目标或工件变化使旧诊断失效。只有当前签名回归、审核、独立复核与账本都走完后才关单。

诊断回执证明这版工件出现的实测现象及所引用的源码位置。因果说明和修法由诊断方提出，总控核实其与证据、任务和修复范围的关系，最终用修后回归检验。

## 已登记的异常输入

维护者可在版本 2 的 `codeTask.diagnostics.inputContracts` 登记公开业务契约。每条提供授权的 JSON 输入配方、一个有效输入 `seed`、精确预期 `expectedJson`，以及待替换的字段 `path`、代表性异常 `invalid` 和对应的精确预期。用空路径替换整个 JSON 根值。`expectedExitCode` 缺省为 0。字段路径也支持数组下标。每次只改一个字段，能清楚定位谁应处理异常。所有有效对照和异常变体合计最多 24 个。

执行方取得当前签名并读回后，宿主在 `submit` 时运行这些探针。当前版本的签名门槛先通过，登记的异常输入也通过后才送审。探针走同一受控运行器，失败返回字段、输入、预期、实际退出或 JSON 差异及可用的堆栈。运行器不可用时保留原阶段，以便核对和重试。回执保存同一工件的检查数量和探针摘要。首审、独立复核和资料真实性继续各走原有验证。

## 独立代码复核复现

维护者可把诊断配置中的数据输入配方加入 `reviewRecipes`。其中一个配方可登记为 `syntaxRecipe`。首审和独立复核仅在当前签名稿、已读目标和完整快照读授权都有效时使用 `building_loop_code_review probe`。运行器沿用上节的隔离快照。复现记录绑定角色、阶段、目标、签名、架构和输入。缓存只在当前角色和这些版本均一致时复用。

- `assertion: "runtime"` 提供已签名的 `file`、已登记 `recipe`、可选 `stdin`、预期退出码以及可选 JSON 输出。若要将结果用于行为退回，运行前一并提供 `requirement` 的 `file`、`start`、`end` 和逐字 `quote`。宿主核对本角色实际读过的当前条款，再运行并保存输入与可观察差异。`findings` 必须关联这条复现；已通过的签名用例只有在同一用例存在确证差异时才能标为待修。按 JSON 值比较。输出截断、运行超时和无效回执只作为待核状态。
- `assertion: "syntax"` 只提供已签名的 `file`。运行器须用受信编译配方读取该文件，成功返回退出码 0 与 `{"status":"parsed"}`。真实语法错误返回退出码 1 与 `{"status":"syntax-error","line":行号}`。Python 可把 `scripts/code-reproduction/python_syntax.py` 作为只读受信助手挂载，固定解释器和助手命令，限制参数为一个收到的签名工件路径。候选代码只被编译，不被导入。
- 无需修改的通过依据和建议写入 `observations`。`findings` 只包含明确的预期与实际差异和必须采取的修复。运行或语法断言须关联本角色、当前版本的失败复现。合法语法的通过结果不可用于语法退回。其余架构和维护性判断继续对照实际目标及源码。

## 已验证稿的送审与代码核验

执行方先检查当前目标、修改和实际用例。当前候选已完成时，用 `prepare` 查看签名与送审条件，或直接提交同一版本。签名正确而仍有待读时，按宿主返回的当前行和待读范围完成读回，再提交该版本。后续修改会生成新版本，需要核对新回执。受控编辑可登记实际返回的当前行，并保留逐字可证的未修改行读回记录。

纯实现代码可进入专用核验。宿主依据已签名的工作单元、实现候选、可写产物类型和项目中登记的文稿义务决定路径。含可写文稿、资料、事实、复算、逐字交付等义务的单元继续使用原核验。专用核验要求两道核验都拥有可写源码的精确读授权。只有部分源码读权的已有项目沿用原核验和签名门槛。升级前已签名送审的单元保留原核验及退回项。同一目标已有代码退回项时，按原代码回执修订。

1. 审阅者用 `building_loop_code_review prepare` 取得当前改动范围、签名回执和新增必测编号。读相关源码、接口上下文及目标，核对不变量、边界行为、失败处理、维护和回滚成本。逐文件记录判断，按必测编号将实际测试与已读要求、已读实现对应起来。
2. 代码审阅同时记录必要注释。对非显然的设计约束和跨模块调用，检查说明的理由、适用边界及实现是否相符。已有准确说明可沿用。已有注释称行为成立时，用实际控制流或可复核用例判断。缺少必要说明或说明与实际行为矛盾时提出可定位的修正。 [代码注释验收](../docs/code-comment-acceptance.md)
3. 首审和独立复核各自用 `building_loop_code_review record` 分批记录结论，工具返回该批的错误和还需核对的文件与测试编号。已验证条目保留，只补对应文件、用例或发现编号。注释原文由宿主从已读行提取。发现须明确实际观察、问题、修法和已读定位，判断控制流时应回到下游读写和反例核对。完成登记后只传 `action: submit`。宿主绑定角色、当前目标、签名结果和落盘工件。两道核验通过后继续原账本复盘。

新的回执入口优先用 `prepare` 返回的 `pending`。宿主按当前签名填入变更文件、必测项和架构章节，按真实展示的行登记 `refs`。用 `record.decisions` 提交该行的 `id`、`status`、简短 `basis`，以及需要的证据编号。已判断的行不必重填。证据编号对应当时已读版本，例如 `S1:12-14` 与 `G1:7`。完整读回并逐节判断后，架构总评由宿主根据已记录的独立判断和退回项生成。若 `submit` 返回 `needs-review`，按 `next` 补具体缺项。该结果不生成验收回执、不结束审核阶段，也不改变执行方的签名要求。

审阅报告的 `files` 逐文件记录理由和必要注释定位，`constraints` 逐项记录必测编号、已读要求和实际实现位置，`findings` 给出问题、位置和修法。签名测试状态由宿主读取当前受信回执。审阅方的技术判断是带实际位置的独立评估，仍由相应会话负责。

已有三级项目可在签名工作单元登记 `architecture: {module, headings}`。总控先走现有受控写入，再调用 `building_loop architecture` 登记。两位审核者都核对当前架构和源码的关系。架构退回交给总控，源码退回交给执行方。已登记架构发生变化要重新审核实际版本。后续目标可用新会话原地接手，开工原文单列工作单元编号，宿主校验授权和当前目标摘要。 [三级导航与架构验收](project-hierarchy.md)

已登记的纯 Python 实现可以选用 `architecture.importsHeading`，指向一个独立的 Markdown 章节。总控登记架构时，宿主从实际授权文件生成可解析的显式本地导入关系，源码通过签名后核对并同步当前图。核验与关单重新读取生成结果。具体职责、控制流、动态导入和适用边界仍须两位审核者对照当前源码判断。
