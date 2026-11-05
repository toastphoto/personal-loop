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
