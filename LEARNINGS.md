# Learnings

- The intended product is continuous project advancement across native systems, not just a Multica intake bot or a two-turn read-only demo. Preserve that scope.
- Check pause again at the final native mutation, after asynchronous preflight. Do not claim cross-system atomicity.
- State hashes identify values, not transitions: A → B → A needs a new event ID. Persist the pending transition before sending.
- Adapter tests alone miss shared-contract bugs. Test projectId/state/nativeState through the catalogue and observer.

- Native projects can have multiple roots. Require an explicit trusted root instead of picking the first.
- A newly created empty Codex thread follows start then prompt; premature read/resume can have incomplete persistence/projection. Never rebuild uncertain work automatically.
- A filesystem sentinel lock can survive a crash and prevent pause. Use an OS-released process lock and test actual process termination.
- Same-batch edited messages and exhausted reply retries must not block later pause commands.
- Match real mention representations, not only synthetic placeholder keys; normalize only verified leading mentions.
- Native tokenUsage.last is one model request. Preserve raw evidence and calculate whole-turn totals from a persisted baseline.

- A successful `py_compile` only proves Python syntax. It did not catch a relay hook referencing `re` without importing it; independent review found the missing global import. Validate extracted pure functions using the candidate deployment script's real namespace, rather than supplying extra test globals that hide missing imports, and then test the actual command classification paths.

- A correct 39-row text inventory was difficult to use on the owner's phone. Start with source groups, fold per-project details, and show identifiers only for disambiguation. User-visible success includes reading and navigation, not just message delivery.
- Same-name and truncated-name project titles need stable disambiguation even in the static folded view; unique callback IDs alone do not make the UI distinguishable.

- Adding controls must preserve a navigation pattern the user already finds clear. The first interactive menu introduced pagination and was rejected; keep native source folds and a full project list, then show controls in project details.
- Re-reading all native providers for every click made navigation slow; the initial query also read twice. Cache directory selection data, overlay local controls/drafts, wake on events, and reserve live reads for refresh and execution checks.
- A pending callback after activation can leave active controls without confirmed rule sync. Recovery must reconcile the exact operation revision; this implementation safely pauses the still-current activation instead of repeating work.
- Unsent cards and idempotent rebinding of older cards must not steal the user's current project context. Remember context only on first successful binding or an authenticated selection.
- Card PATCH has no cross-service revision transaction: an unknown older request can arrive late. Block stale actions and refresh on another click; do not promise atomic remote ordering.
- Synthetic test renaming must update partial-name cases too; otherwise a test stops exercising its intended ambiguity contract.

- Project-control status alone did not let the owner judge real progress. Add the selected native Issue/session and its last visible Agent reply with source/time/truncation, without relabelling stored metadata as live execution.
- Remaining run budget does not schedule another run. A valid later/event/answer or observer trigger is needed; do not call configured capability a fully accepted autonomous workflow.
- Upstream receipt repair reused a run ID that our wrapper deduplicated, replaying the same invalid receipt and usage. Validate before hand-in; preserve the original and stop safely for investigation instead of redoing business.
- Package staging must use explicit paths when the shell working directory is the plugin subdirectory; a failed documentation edit must not be mistaken for a completed release update.

- Validate protocol enums against the installed native schema. The owned executor's active-turn read/cancel preflight used obsolete itemsView="none"; switch to notLoaded without weakening project/turn identity checks.

- Upstream retries reuse a run ID but increment attempt. Deduplicating by run alone replayed failed results and usage without retrying. Separate attempt identity, require a verified failed predecessor, and count each real attempt against budget.
- Cached replay needs the same goal and control revision as well as an idempotency key. Recheck after asynchronous catalogue work; do not suppress results of newly completed work merely because the owner paused afterward.
- Do not label the nightly suite passed when deep checks pass but performance budgets fail. Keep measured failures, isolate resource-sensitive checks and compare baseline without loosening thresholds.

- Test project controls and decision buttons separately. Confirm the question uses a button on its delivered message, the authorized click creates one answer event, and that event wakes the intended native goal.

- Phone project cards should lead with the outcome and the next decision. Distinguish past goals and conversation history from active work. Check what is visible with every optional panel closed.

- A project is not a conversation. Bind the owner-selected conversation, including legacy chats verified by exact root, separately from the native project. An accepted queue entry establishes delivery intent; report execution only after matching it to the original thread and turn.

- Show available working chats and mark the selected one in the project card. A person should not need to memorize a title. Selecting a destination, saving a draft, and starting a goal are distinct actions.

- A missing exact project name is not evidence that a conversational question refers to a nonexistent project. Resolve global scope and user intent first, read actual state, and keep unknown native activity distinct from idle work. Route external operations independently of a read-only chat answer.

- A completed public assistant message can establish a project checkpoint before its enclosing turn ends. A trial round count is not a default stopping rule. Use verified progress to continue, preserve decisions and completed-step identity, and close only an acknowledged overall finish.

- 2026-11-07: Do not apply a phone notice length limit to private coordinator evidence. A real navigation run repeatedly requested sections present after character 1600. Preserve bounded full evidence separately; explicit omissions are not missing business work. Regression covers the lost trailing coverage statement.

- 2026-11-07｜语义服务超时不应说用户范围不清。明确只读目录不依赖模型；复杂自然语句保留语义路由，按实测时延设置期限并保留安全错误诊断。对已有项目的继续/条件式推进必须回到项目控制，不能分流成新Multica任务。源消息经本人/原群核验后，只修复原回复，不假造点击或启动证据。

- 2026-11-08｜“缺资料”固定生成“已处理/暂停”并推荐前者，导致真人点选后没有资料、反复再问。改为填写回复后发送，选择不等于资源存在，普通工程排障先自行处理。已验证真实文字接回原对话；手机新表单提交待实测。
- 2026-11-08｜先前只把45秒改180秒，没有解决慢。逐事件计时证实WebSocket连续超时后才切HTTPS；隔离子进程直接HTTPS约6秒，保留登录和权限，全局设置未改。
- 2026-11-08｜阶段通知经source.tell创建时为closed/FYI，原发送层只对open加@导致真实漏提醒。首次notice也应@；已发送后更新不重复@。回执核对不应指数退避到半小时而拖慢下一步，已用原Hub的短预约核对。

- 2026-11-08｜用户指出原对话每轮重复完整目标、旧的缺资料选项及通用规则，还将旧选择称为“刚刚”。改为首次交接说明目标，后续只发本轮安排/完成标准；只有真实的新回答才附新回复或选择。旧决定保留在协调状态，不再复制整段到原聊天。三条真实安排从约1240–1249字降为307–316字，约减75%；多轮选择、暂停恢复和去重仍有回归覆盖。

- 2026-11-08｜真人表单回传已验：核对真实回调、保存内容和精确原生输入，再看原对话已完成；之后经正常控制入口恢复同一目标，并核见新的实际执行。wake-requested不等于冷启动通过，本人已明确将冷启动延期。

- 2026-11-08｜把手机易读等同于一律100字摘要，导致本人看不到实际页面，也无法判断完整程度。应先交付可看的真实成果，再附适量说明与必要决定；以用户流程为里程碑，工程检查作为展开证据。不能因窗口未验就用旧截图或虚构预览冒充。交付链补建待实施。

- 2026-11-08：预览默认展开长编号仍妨碍阅读，已把技术明细收起；检查结束必须更新终态，不能一直显示正在检查。真实截图需对应最终包。托管成功不等于手机可访问，本轮浏览器连接超时和私有登录边界保留。内网评审站不可达时不擅改公司服务器，采用独立私有测试资源。

- 2026-11-08：只有项目名和长日志开头不足以接手，容器项目还会漏掉子模块。以简短项目接手说明恢复全局，决定文件保留最新尾部，所有截断显式标记；语义定位使用已登记目录的用途，不凭简称猜执行目标。免登录预览必须用无凭据请求验证，私有部署成功不代表手机可看。

- 2026-11-09｜协调层按局部快照直接编排技术步骤，项目侧也未及时用完整用户旅程约束细拆，导致共享草稿/检查支线挤占主App。由原项目Agent复核主线和选择下一里程碑；临时会话只汇报，任务/选项/验收原样取自原对话认可的项目报告。读更多上下文不能替代职责划分。公司项目已出纠偏报告；真实接续链验证进行中。

- 2026-11-09｜已经结束却无法唯一归属最终回复的原回合，被标成in-thread并反复等待，造成开启推进但没有新任务。原生完成与单项成功要分开；仅在已验证结束时转项目报告复核，不把旧任务冒称成功或重做。现已有旧等待解除、报告原样派发和原聊天实际执行证据，阶段成果及自动@现已官方读回，后续业务验收继续。

- 2026-11-09｜将局部预览“未接模型/桌面”的边界泛化成全项目能力缺失，会诱导重复造壳。原项目主责应区分主App历史实证、当前切片与本轮复验，大肥鱼按这个范围汇报，不用局部缺项否定已有主线成果。

- 2026-11-09｜仅把截图自动发出去，会让本人回复图文时丢失项目指代。发送记录必须保留原群/本人/项目/原对话和官方读回，再作为只读上下文线索，不作为新授权；同名或绑定变化不冒认。已做混合话题回归与真实消息的本地回复关联验证。
- 2026-11-09｜交付试点不能把当前规划说成实施完成。使用项目Agent明确标注日期/版本的历史实际成果，保留未验范围；交付失败只重试消息，不能重跑业务。已自动发送并核重载无重复。
- 2026-11-09｜本地验收辅助脚本曾只传projectKey调用别名函数，缺provider/host/nativeId导致失败；先读实际签名再构造三元身份。修正后模拟回复准确定位原公司项目，未伪造真实飞书输入。
