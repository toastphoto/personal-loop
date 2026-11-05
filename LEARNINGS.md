# Learnings

- The intended product is continuous project advancement across native systems, not just a Multica intake bot or a two-turn read-only demo. Preserve that scope.
- Check pause again at the final native mutation, after asynchronous preflight. Do not claim cross-system atomicity.
- State hashes identify values, not transitions: A → B → A needs a new event ID. Persist the pending transition before sending.
- Adapter tests alone miss shared-contract bugs. Test projectId/state/nativeState through the catalogue and observer.
