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
