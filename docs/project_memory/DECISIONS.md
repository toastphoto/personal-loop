# Decisions

- Keep native project/session identity in Codex, Multica and DSH; do not move everything into Multica. Reassess only if the user changes scope.
- Reuse upstream autoloop scheduling, facts, waits and cards. Add provider connectors and project controls outside the kernel.
- Default every project to manual; require explicit enable/resume, persist pause, distinguish pause from cancelling the current task.
- Separate catalogue access from control access. No private IPC, cookie copying, or a fresh empty host masquerading as the desktop.
- Uncertain mutations need reconciliation, not blind retries. Native completion is not business acceptance.
