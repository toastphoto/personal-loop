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
