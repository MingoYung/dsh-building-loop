# cordis.patch.yml 更新日志

## 2026-11-06

- 真实回合在渲染 persona 时发现该宿主未注册 `cwd` 提示变量。移除 `{{cwd}}`，继续使用会话的实际工作区。
- 重组 persona 的开工检查、三级读取、文件事实、滚动备份、总控权限、会话复用和交付规则。预设工具由 DSH 现有宿主提供。
- 在 DSH `0.2.2-rc.1` 隔离 Profile 新建会话，确认新版 persona 参与提示组装，两份技能和证据附录可读，原生 `list_agents` 可执行，`send_message` 和 `subagent` 已注册。
