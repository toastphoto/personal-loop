# 项目主责与临时汇报

启用 `managedCodex.coordinationMode=project-led` 后，已绑定项目由原项目Agent决定技术路线和下一段可见成果。大肥鱼负责目标、暂停、提醒、排队和人类决策接回；临时会话只压缩项目报告，不设计任务。

原项目保存 `docs/project_memory/PROJECT_REPORT.json`：
- `schemaVersion: 1`、`updatedAt`（含时区）、`projectGoal`、`diagnosis`、`evidence`（仓库内相对路径）
- `action: dispatch`：`progress`、`nextStep`、`expectedResult`
- `action: ask`：上述字段加一个`question`、2–5个`options`、从0起的`recommend`及`reason`
- `action: finish`：仅整体本人目标完成时，给`summary`、`reason`

最终回复开头附`PROJECT_REPORT_SHA256:`和文件真实SHA-256。原聊天身份仍由可信绑定核实；只有其最新完整最终回复认可的原样报告可用于推进。临时汇报员只能返回摘要和同一校验值，不能输出或改写行动字段。程序沿用原报告中的任务、标准和选项，提交前再核报告未变化。

缺失、过期或无法匹配的报告先交原项目核实补齐，不由中台猜技术路线。切换模式时，尚未派发的旧中央规划必须重新读取项目报告。本人回答回同一原聊天，由项目Agent判断如何落实；不得将选项当成资源已具备。

报告是受限项目范围内的安排和证据，不是新增权限。已有目标代次、控制版本、原聊天绑定、重复步骤、回答去重和暂停检查仍保留。临时会话不留新侧栏聊天。当前是否上线、真实阶段通知和继续执行分别以ACTIVE_CONTEXT及实测记录为准。

已有可展示成果的阶段，另按[阶段成果交付](ARTIFACT_DELIVERY.md)提交不可变素材声明；交付不改写下一步、不重跑业务。仅准备材料不能声称已送达，送达由通道读回确认。是否启用该项目的自动发送，以实际通道配置和本人授权为准。
