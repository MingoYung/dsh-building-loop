# 隔离执行代码复现

这条命令供受信诊断服务调用。维护者登记固定运行时与入口，服务把当前授权工件解码到新建的私有快照目录，检查内容摘要，再把快照交给探针。被测进程只能看到只读快照、登记的只读运行时与独立临时目录。Linux 需要 Python 3、`/usr/bin/bwrap` 和可用的非特权用户命名空间。也可在具备这些条件的 WSL 发行版使用。

```sh
python3 scripts/code-reproduction/probe.py /trusted/recipe.json /trusted/request-snapshot < probe.json
```

适用于在 `/usr` 提供 Python 的发行版的示例配方如下。根据安装位置调整运行时挂载，按项目需要开放参数、文件数和标准输入。探针与 DSH 工具使用相同的最高额度，每次最多 24 个参数、12 个样例文件和 16 KiB 样例总量。下例登记了更小的配方额度。动态参数始终放在已登记入口后，保持各自独立的 argv 边界。维护者应登记只接收数据的程序入口。

```json
{
  "executable": "/usr/bin/python3",
  "entrypoint": "src/normalize.py",
  "fixedArgs": ["-E", "-s", "-B"],
  "mounts": [{"source": "/usr", "target": "/usr"}],
  "links": [{"target": "/lib", "source": "/usr/lib"}, {"target": "/lib64", "source": "/usr/lib64"}],
  "maxArgs": 2,
  "maxFiles": 1,
  "allowStdin": true,
  "timeoutMs": 4000
}
```

下面的 JSON 会把样本写入 `/scratch/sample.txt`，并以 `/scratch` 为工作目录执行。所有输入字段可选。也可登记固定原生可执行文件并省略 `entrypoint`。

```json
{
  "args": ["sample.txt"],
  "files": [{"path": "sample.txt", "content": "A  B\n"}],
  "stdin": "extra context\n"
}
```

返回包含 `status`、`exitCode`、`stdout`、`stderr`、`frames` 和 `truncated`。程序实际退出时 `status` 为 `exited`，其余状态为 `timeout`、`output-limit`、`unavailable`。每路输出预览最多 2,048 字节，Python 堆栈最多保留末尾六条指向快照文件的有效位置。服务向模型发布前需清理凭证、绝对路径、不可公开的内容及终端控制字符。候选程序可以打印自定义输出，日志和帧应当作为诊断数据处理。

探针不直接读取项目工作目录、签名密钥或测试套件。运行时目录由维护者选择，挂载前应确认可让候选程序读取全部挂载内容。探针限制单次进程、输入、临时写入、输出与时限。服务另外承担调用频率、并发、整机资源和正式签名隔离。

```sh
python3 -B scripts/code-reproduction/test_probe.py
```
