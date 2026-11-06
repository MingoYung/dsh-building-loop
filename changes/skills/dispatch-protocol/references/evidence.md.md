# skills/dispatch-protocol/references/evidence.md 更新日志

## 2026-11-06

- 新建按需读取的来源核验约定，把断言、原始定位、适用条件和结论绑定。参考 ClearAI `0.5.8` 的 `validateAuditEvidence`，缺引用、位置无效或判据缺失时降级，留给执行方补查。查阅于 2026-11-06。[ClearAI 核验实现](https://github.com/Clearailhc/clearai-dsh/blob/f97e0c32672dbd36378523632785cdbd80855c93/preset/plugins/audit-evidence.js)
